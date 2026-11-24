#!/usr/bin/env bash
# Sourced by launch-campus.sh. Keep the Cloudflare API token in this shell only.

cf_api() {
  local method="$1" path="$2" response
  shift 2
  response="$(curl -q -sS --connect-timeout 10 --max-time 35 --request "$method" \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$cloudflare_api_token") \
    --header 'Content-Type: application/json' "$@" "https://api.cloudflare.com/client/v4$path")"
  if ! jq -e '.success == true' >/dev/null <<<"$response"; then
    printf 'Cloudflare request failed: %s %s (API codes: %s)\n' "$method" "$path" \
      "$(jq -r '[.errors[]?.code | tostring] | join(", ")' <<<"$response")" >&2
    return 1
  fi
  jq -c '.result' <<<"$response"
}

cf_record_state() {
  cf_api GET "/zones/$zone_id/dns_records?name.exact=$hostname&per_page=100" |
    jq -c --arg hostname "$hostname" 'map(select(.name == $hostname))'
}

cf_authenticate() {
  local zone records existing
  read -rsp 'Cloudflare API token (input hidden): ' cloudflare_api_token </dev/tty
  printf '\n' >&2
  [[ "$cloudflare_api_token" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  zone="$(cf_api GET '/zones?name=dblab.site&status=active' | jq -cer '
    map(select(.name == "dblab.site" and .status == "active")) | select(length == 1) | .[0]')"
  zone_id="$(jq -er '.id | select(test("^[0-9a-f]{32}$"))' <<<"$zone")"
  account_id="$(jq -er '.account.id | select(test("^[0-9a-f]{32}$"))' <<<"$zone")"
  tunnel_endpoint="/accounts/$account_id/cfd_tunnel"
  records="$(cf_record_state)"
  if [[ -s "$state/tunnel.id" ]]; then
    tunnel_id="$(cat "$state/tunnel.id")"
    [[ "$tunnel_id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
    cf_api GET "$tunnel_endpoint/$tunnel_id" | jq -e '
      .name == "dbl-campus-production" and (.config_src == "cloudflare" or .remote_config == true)
    ' >/dev/null
    cf_validate_record "$records"
  else
    jq -e 'length == 0' >/dev/null <<<"$records" || {
      echo 'A DNS record already exists at campus.dblab.site. No record was changed.' >&2
      return 1
    }
    existing="$(cf_api GET "$tunnel_endpoint?name=dbl-campus-production&is_deleted=false")"
    jq -e 'length == 0' >/dev/null <<<"$existing" || {
      echo 'A tunnel with this name already exists. No existing tunnel was changed.' >&2
      return 1
    }
  fi
}

cf_prepare() {
  local records payload
  records="$(cf_record_state)"
  if [[ -z "${tunnel_id:-}" ]]; then
    jq -e 'length == 0' >/dev/null <<<"$records" || {
      echo 'The Campus DNS record appeared while preparing the host.' >&2
      return 1
    }
    tunnel_id="$(cf_api POST "$tunnel_endpoint" --data-binary \
      '{"name":"dbl-campus-production","config_src":"cloudflare"}' | jq -er '.id')"
    [[ "$tunnel_id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
    printf '%s\n' "$tunnel_id" >"$state/tunnel.id"
  else
    cf_validate_record "$records"
  fi

  payload="$(jq -nc --arg host "$hostname" '{config:{ingress:[{hostname:$host,service:"http://127.0.0.1:8080"},{service:"http_status:404"}]}}')"
  cf_api PUT "$tunnel_endpoint/$tunnel_id/configurations" --data-binary "$payload" >/dev/null
  cf_api GET "$tunnel_endpoint/$tunnel_id/token" | jq -er 'strings | select(length > 32)' >"$work/tunnel.token"
}

cf_validate_record() {
  jq -e --arg target "$tunnel_id.cfargotunnel.com" '
    length == 0 or (length == 1 and (.[0] | .type == "CNAME" and .content == $target and .proxied == true))
  ' >/dev/null <<<"$1" || {
    echo 'The current hostname has DNS records outside the expected tunnel route.' >&2
    return 1
  }
}

cf_publish() {
  local connected=0 records payload
  for attempt in {1..15}; do
    if cf_api GET "$tunnel_endpoint/$tunnel_id" | jq -e '.status == "healthy"' >/dev/null; then
      connected=1
      break
    fi
    sleep 4
  done
  [[ "$connected" == 1 ]] || { echo 'The named tunnel did not become healthy.' >&2; return 1; }
  records="$(cf_record_state)"
  cf_validate_record "$records"
  if jq -e 'length == 0' >/dev/null <<<"$records"; then
    payload="$(jq -nc --arg host "$hostname" --arg target "$tunnel_id.cfargotunnel.com" \
      '{type:"CNAME",name:$host,content:$target,proxied:true,ttl:1}')"
    cf_api POST "/zones/$zone_id/dns_records" --data-binary "$payload" >/dev/null
  fi
  records="$(cf_record_state)"
  cf_validate_record "$records"
  jq -e 'length == 1' >/dev/null <<<"$records"
  unset cloudflare_api_token
  printf 'PASS: verified named Cloudflare Tunnel and DNS route for %s\n' "$hostname"
}
