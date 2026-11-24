#!/usr/bin/env bash
# Run in the project owner's authenticated Cloud Shell. The only prompt is the scoped Cloudflare token.
set +x
set -euo pipefail
umask 077

[[ -t 0 && $# -le 1 ]] || { echo 'Run interactively in Cloud Shell.' >&2; exit 2; }
mode="${1:-}"
case "$mode" in ''|--resume|--resume-acceptance|--resume-load) ;; *)
  echo 'Usage: launch-campus.sh [--resume|--resume-acceptance|--resume-load]' >&2
  exit 2
esac
resume=false
[[ $# == 0 ]] || resume=true
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || {
  echo 'Use a clean, reviewed Git checkout.' >&2
  exit 2
}
source deploy/gce/cloudflare-route.sh

hostname=campus.dblab.site
origin="https://$hostname"
project=dbl-campus
zone=us-central1-a
vm=dbl-campus
state="$HOME/.config/dbl-campus-launch"
install -d -m 0700 "$state"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ssh_vm() {
  gcloud compute ssh "$vm" --project="$project" --zone="$zone" --tunnel-through-iap \
    --quiet --ssh-flag=-oConnectTimeout=8 --command="$1"
}

copy_vm() {
  gcloud compute scp --project="$project" --zone="$zone" --tunnel-through-iap --quiet \
    "$@" "$vm:$remote/"
}

deploy_profile() {
  [[ "$1" == live || "$1" =~ ^(pilot|recovery)-[a-f0-9]{12}$ ]]
  [[ -z "${2:-}" || "$2" == --recreate-app ]]
  ssh_vm "sudo bash -s -- '$1' ${2:-}" <deploy/gce/deploy-profile.sh
}

configure_budget() {
  local account number existing
  account="$(gcloud billing projects describe "$project" --format='value(billingAccountName)')" || return 1
  [[ "$account" =~ ^billingAccounts/[A-Z0-9-]+$ ]] || return 1
  number="$(gcloud projects describe "$project" --format='value(projectNumber)')" || return 1
  [[ "$number" =~ ^[0-9]+$ ]] || return 1
  existing="$(gcloud billing budgets list --billing-account="${account#billingAccounts/}" --format=json)" || return 1
  if ! jq -e --arg project "projects/$number" 'any(.[]; .displayName == "DBL Campus spending alert"
      and .budgetFilter.projects == [$project])' >/dev/null <<<"$existing"; then
    gcloud billing budgets create --billing-account="${account#billingAccounts/}" \
      --display-name='DBL Campus spending alert' --filter-projects="projects/$number" \
      --budget-amount=1USD --threshold-rule=percent=0.01 --threshold-rule=percent=1.0 --format=none || return 1
  fi
  echo 'PASS: project billing alert configured. It does not cap usage.'
}

wait_health() {
  for attempt in {1..40}; do
    if curl -4fsS --max-time 6 "$origin/api/health" 2>/dev/null | jq -e '
      .status == "ok" and .database == "ok" and .storageWritable and .httpsEnforced and (.demoEnabled == false)
    ' >/dev/null; then
      return 0
    fi
    sleep 5
  done
  echo 'The HTTPS endpoint is not ready.' >&2
  return 1
}

gcloud compute instances describe "$vm" --project="$project" --zone="$zone" --format=json | jq -e '
  .status == "RUNNING" and (.machineType | endswith("/e2-micro"))
  and (.networkInterfaces | length == 1)
  and (.networkInterfaces[0] | ((.accessConfigs // []) | length == 0) and (.ipv6AccessConfigs | length == 1))
  and any(.disks[]; .deviceName == "campus-data" and .autoDelete == false)
' >/dev/null
ssh_vm 'sudo -n true && sudo test ! -e /etc/dbl-campus/live.env' || {
  echo 'IAP requires administrative OS Login, or Campus live setup is already present.' >&2
  exit 1
}
if "$resume"; then
  profile="$(ssh_vm 'sudo cat /etc/dbl-campus/active-profile')"
  [[ "$profile" =~ ^(pilot|recovery)-([a-f0-9]{12})$ ]] || {
    echo 'Resume requires an existing synthetic acceptance profile.' >&2
    exit 1
  }
  id="${BASH_REMATCH[2]}"
  image="$(ssh_vm 'sudo cat /opt/dbl-campus/current/image')"
  [[ "$image" =~ ^dbl-campus:([a-f0-9]{40})$ ]]
  release="${BASH_REMATCH[1]}"
  ssh_vm "sudo docker image inspect '$image' 'dbl-campus-cloudflared:$release' >/dev/null"
  echo "Reusing the existing Campus release and $profile profile."
else
  if ! configure_budget; then
    echo 'Billing alert could not be configured with these permissions. Review billing before inviting students.' >&2
  fi
  release="$(git rev-parse HEAD)"
  remote="$(ssh_vm 'mktemp -d /tmp/dbl-campus-launch.XXXXXXXX')"
  [[ "$remote" =~ ^/tmp/dbl-campus-launch\.[A-Za-z0-9]+$ ]]
  copy_vm deploy/gce/prepare-host.sh
  ssh_vm "sudo bash '$remote/prepare-host.sh' && rm '$remote/prepare-host.sh'"

  docker build --platform linux/amd64 --tag "dbl-campus:$release" .
  docker pull --platform linux/amd64 caddy:2-alpine
  docker pull --platform linux/amd64 cloudflare/cloudflared:latest
  docker image tag cloudflare/cloudflared:latest "dbl-campus-cloudflared:$release"
  docker save "dbl-campus:$release" caddy:2-alpine "dbl-campus-cloudflared:$release" |
    gzip -1 >"$work/images.tar.gz"
  tar -czf "$work/runtime.tar.gz" docker-compose.yml Caddyfile deploy/gce/compose.yml \
    deploy/gce/compose.tunnel.yml deploy/gce/Caddyfile.tunnel deploy/gce/deploy-profile.sh deploy/gce/host-metrics.sh
  (cd "$work" && sha256sum images.tar.gz runtime.tar.gz >checksums)
  copy_vm "$work/images.tar.gz" "$work/runtime.tar.gz" "$work/checksums"
  ssh_vm "cd '$remote' && sha256sum -c checksums && sudo docker load -i images.tar.gz && \
    sudo install -d -m 0700 /opt/dbl-campus/releases/$release && \
    sudo tar -xzf runtime.tar.gz -C /opt/dbl-campus/releases/$release && \
    printf '%s\\n' dbl-campus:$release | sudo tee /opt/dbl-campus/releases/$release/image >/dev/null && \
    sudo ln -sfn /opt/dbl-campus/releases/$release /opt/dbl-campus/current && \
    rm images.tar.gz runtime.tar.gz checksums && rmdir '$remote'"

  id="$(openssl rand -hex 6)"
  profile="pilot-$id"
  deploy_profile "$profile"
fi
pilot="pilot-$id"
recovery="recovery-$id"
qa_state="$state/acceptance/$id"
install -d -m 0700 "$qa_state"
if [[ "$profile" != "$pilot" ]]; then
  [[ -s "$qa_state/fixture.json" && -s "$qa_state/backup.json" ]]
  deploy_profile "$pilot"
fi
ssh_vm 'bash -s' <deploy/gce/wait-origin.sh
if [[ "$mode" == --resume-acceptance || "$mode" == --resume-load ]]; then
  ssh_vm "test \"\$(sudo docker inspect --format '{{.Config.Image}} {{.State.Running}}' dbl-campus-tunnel)\" = 'dbl-campus-cloudflared:$release true'"
  echo 'Reusing the running Cloudflare connector and current DNS route.'
else
  cf_authenticate
  
  tunnel_container="$(ssh_vm "sudo docker container ls -a --filter name='^/dbl-campus-tunnel$' --format '{{.Names}}' ")"
  if [[ -z "$tunnel_container" ]]; then
    cf_prepare
    remote="$(ssh_vm 'mktemp -d /tmp/dbl-campus-launch.XXXXXXXX')"
    [[ "$remote" =~ ^/tmp/dbl-campus-launch\.[A-Za-z0-9]+$ ]]
    copy_vm "$work/tunnel.token"
    rm "$work/tunnel.token"
    ssh_vm "sudo install -o 65532 -g 65532 -m 0400 '$remote/tunnel.token' /etc/dbl-campus/tunnel.token && \
      rm '$remote/tunnel.token' && rmdir '$remote' && \
      sudo docker run -d --name dbl-campus-tunnel --restart unless-stopped --network host \
        --read-only --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges \
        --log-opt max-size=5m --log-opt max-file=2 \
        --mount type=bind,src=/etc/dbl-campus/tunnel.token,dst=/run/tunnel.token,readonly \
        dbl-campus-cloudflared:$release tunnel --no-autoupdate --edge-ip-version 6 \
        --protocol http2 run --token-file /run/tunnel.token >/dev/null"
  else
    [[ "$tunnel_container" == dbl-campus-tunnel && -n "${tunnel_id:-}" ]]
    ssh_vm "test \"\$(sudo docker inspect --format '{{.Config.Image}}' dbl-campus-tunnel)\" = 'dbl-campus-cloudflared:$release' && \
      if [ \"\$(sudo docker inspect --format '{{.State.Running}}' dbl-campus-tunnel)\" != true ]; then sudo docker start dbl-campus-tunnel >/dev/null; fi"
  fi
  cf_publish
fi

wait_health
ssh_vm "curl -6fsS --max-time 15 '$origin/api/health' >/dev/null"
redirect="$(curl -4sS --max-time 15 --output /dev/null --write-out '%{redirect_url}' "http://$hostname/")"
[[ "$redirect" == "$origin/" ]] || { echo 'HTTP did not redirect to the official HTTPS URL.' >&2; exit 1; }

accept=(python3 deploy/gce/acceptance.py)
accept_with_setup() {
  local setup_code
  setup_code="$(ssh_vm "sudo sed -n 's/^DBL_ADMIN_SETUP_CODE=//p' /etc/dbl-campus/$1.env")"
  [[ "$setup_code" =~ ^[a-f0-9]{64}$ ]]
  CAMPUS_ACCEPTANCE_SETUP_CODE="$setup_code" "${accept[@]}" "$2" "$origin" "$qa_state/fixture.json" \
    --backup "$qa_state/backup.json"
}

if [[ -s "$qa_state/fixture.json" && -s "$qa_state/backup.json" ]]; then
  "${accept[@]}" verify "$origin" "$qa_state/fixture.json"
elif [[ "$mode" == --resume-load ]]; then
  echo 'The saved synthetic fixture and backup are both required to resume the load test.' >&2
  exit 1
else
  accept_with_setup "$pilot" seed
fi

if [[ "$mode" == --resume-load ]]; then
  echo 'Saved synthetic records verified. Continuing at the load test.'
else
  before="$(ssh_vm 'cat /proc/sys/kernel/random/boot_id')"
  if ! ssh_vm 'sudo systemctl reboot'; then
    echo 'SSH closed during the VM reboot request. Checking its boot ID.'
  fi
  after="$before"
  for attempt in {1..25}; do
    after="$(ssh_vm 'cat /proc/sys/kernel/random/boot_id' 2>/dev/null)" || after="$before"
    [[ -n "$after" && "$after" != "$before" ]] && break
    sleep 4
  done
  [[ -n "$after" && "$after" != "$before" ]] || { echo 'The VM reboot was not observed.' >&2; exit 1; }
  wait_health
  "${accept[@]}" verify "$origin" "$qa_state/fixture.json"
  echo 'PASS: verified data after VM reboot.'

  deploy_profile "$pilot" --recreate-app
  wait_health
  "${accept[@]}" verify "$origin" "$qa_state/fixture.json"
  echo 'PASS: verified data after application redeployment.'
fi
"${accept[@]}" load "$origin" "$qa_state/fixture.json" --workers 4 &
load_pid=$!
ssh_vm 'sudo env CAMPUS_DATA_PATH=/srv/dbl-campus-data bash /opt/dbl-campus/current/deploy/gce/host-metrics.sh'
wait "$load_pid"

deploy_profile "$recovery"
wait_health
if curl -4fsS --max-time 10 "$origin/api/auth/status" | jq -e '.hasProductionRepresentative == false' >/dev/null; then
  accept_with_setup "$recovery" restore
fi
deploy_profile "$recovery" --recreate-app
wait_health
"${accept[@]}" verify "$origin" "$qa_state/fixture.json"

deploy_profile live
wait_health
curl -4fsS --max-time 10 "$origin/api/auth/status" | jq -e '.hasProductionRepresentative == false' >/dev/null
ssh_vm "curl -6fsS --max-time 15 '$origin/api/health' >/dev/null"
echo "READY: $origin"
echo 'The live database is empty. Retrieve the first-use setup code in your own Cloud Shell when ready.'
