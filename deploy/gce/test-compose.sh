#!/usr/bin/env bash
# Verify production limits, localhost edge and persistence without provisioning Google Cloud.
set -euo pipefail
export COMPOSE_PROJECT_NAME=campus-gce-ci
export CAMPUS_IMAGE=campus-gce-fixture:ci
export APP_URL=https://campus.example.net DOMAIN=campus.example.net
export DBL_ADMIN_SETUP_CODE=ci-bootstrap-test-123456789abcdef
export DBL_SESSION_SECRET=ci-session-test-other-123456789abc
export CAMPUS_ACCEPTANCE_SETUP_CODE="$DBL_ADMIN_SETUP_CODE"
work=$(mktemp -d)
chmod 700 "$work"
export CAMPUS_DATA_PATH="$work/data"
mkdir "$CAMPUS_DATA_PATH" "$work/restore"
compose=(docker compose -f docker-compose.yml -f deploy/gce/compose.yml -f deploy/gce/compose.tunnel.yml)
cleanup() {
  "${compose[@]}" logs --tail=25
  "${compose[@]}" down --volumes
  sudo rm -rf "$work"
}
trap cleanup EXIT

docker build -t "$CAMPUS_IMAGE" .
"${compose[@]}" config --format json | jq -e '
  (.services.caddy.ports | length == 1 and .[0].host_ip == "127.0.0.1" and .[0].target == 8080) and
  (.services.app.mem_limit == "536870912" or .services.app.mem_limit == 536870912) and
  ([.services.app.volumes[] | select(.target == "/data" and .type=="bind")] | length == 1)'
"${compose[@]}" up -d --wait --no-build
bash deploy/gce/wait-origin.sh
fixture=(python3 deploy/gce/acceptance.py)
target=http://127.0.0.1:8080
redirect="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' -H 'X-Forwarded-Proto: http' "$target/api/health")"
[[ "$redirect" == '308 https://campus.example.net/api/health' ]]
headers="$(curl -fsS -D - -o /dev/null "$target/api/health")"
grep -Eiq '^Cache-Control: private, no-store[[:space:]]*$' <<<"$headers"
"${fixture[@]}" seed "$target" "$work/state.json" --backup "$work/backup.json" --ci-loopback
"${compose[@]}" restart app
"${compose[@]}" up -d --wait --no-build
"${fixture[@]}" verify "$target" "$work/state.json" --ci-loopback
"${compose[@]}" up -d --wait --no-build --force-recreate
"${fixture[@]}" verify "$target" "$work/state.json" --ci-loopback
"${fixture[@]}" load "$target" "$work/state.json" --ci-loopback
docker stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} RAM={{.MemUsage}} net={{.NetIO}}'
export CAMPUS_DATA_PATH="$work/restore"
"${compose[@]}" up -d --wait --no-build --force-recreate
"${fixture[@]}" restore "$target" "$work/state.json" --backup "$work/backup.json" --ci-loopback
"${compose[@]}" up -d --wait --no-build --force-recreate
"${fixture[@]}" verify "$target" "$work/state.json" --ci-loopback
