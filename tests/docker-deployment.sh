#!/usr/bin/env bash
set -euo pipefail
export COMPOSE_PROJECT_NAME=campus-deployment-ci
export DOMAIN=localhost APP_URL=https://localhost
export DBL_ADMIN_SETUP_CODE=testing-only-bootstrap-secret-0123456789
export DBL_SESSION_SECRET=testing-only-session-secret-012345678901
work=$(mktemp -d)
cleanup() {
  docker compose logs --tail=25
  docker compose down --volumes
  rm -rf "$work"
}
trap cleanup EXIT

docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose exec -T app sh -c 'grep "^Uid:" /proc/1/status | grep -q 1000'
# Caddy issues a local TLS certificate. Trust only the CI project's generated CA.
for attempt in $(seq 1 30); do
  if docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$work/ca.pem" 2>/dev/null &&
     curl --cacert "$work/ca.pem" --silent --fail https://localhost/api/health >"$work/health.json"; then
    break
  fi
  sleep 1
done
call() { curl --cacert "$work/ca.pem" --silent --show-error --fail "$@"; }
[[ $(curl -s -o /dev/null -w '%{http_code}' http://localhost/) == 308 ]]
jq -e '.status=="ok" and .demoEnabled==false' "$work/health.json"
call https://localhost/manifest.webmanifest | jq -e '.display=="standalone"'
call https://localhost/sw.js >/dev/null
pass='ContainerTest-Password-Only123'
setup=$(jq -nc --arg code "$DBL_ADMIN_SETUP_CODE" --arg password "$pass" \
  '{setupCode:$code,universityId:"docker-ci",fullName:"Container Test",email:"docker-ci@example.invalid",password:$password}')
token=$(call -H 'Content-Type: application/json' --data-binary "$setup" https://localhost/api/auth/setup-production-rep | jq -er .token)
auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')
course=$(call "${auth[@]}" -d '{"code":"CI101","nameAr":"مقرر الاختبار","nameEn":"Test course","instructor":"Fixture"}' \
  https://localhost/api/courses | jq -er .id)
text=$(printf 'Persistent attachment fixture' | base64 -w 0)
file=$(call "${auth[@]}" -d "$(jq -nc --arg id "$course" --arg text "$text" \
  '{courseId:$id,title:"Test file",fileName:"fixture.txt",base64Content:$text}')" https://localhost/api/files | jq -er .id)
docker compose up -d --wait --force-recreate app caddy
call "${auth[@]}" "https://localhost/api/files/$file/download" | grep -Fx 'Persistent attachment fixture'
call "${auth[@]}" https://localhost/api/admin/backup |
  jq -e --arg id "$file" '.tables.library_files[0].id==$id and (.attachments|length)==1'
