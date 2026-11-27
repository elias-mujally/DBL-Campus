#!/usr/bin/env bash
# Switch between isolated synthetic and live databases on the dedicated disk.
set -euo pipefail
umask 077

[[ $EUID == 0 && ( $# == 1 || ( $# == 2 && $2 == --recreate-app ) ) ]] || {
  echo 'Run as root with a profile name and optional --recreate-app.' >&2
  exit 2
}
profile="$1"
[[ "$profile" == live || "$profile" =~ ^(pilot|recovery)-[a-f0-9]{12}$ ]] || exit 2
runtime=/opt/dbl-campus/current
storage=/srv/dbl-campus-data
mountpoint -q "$storage"
[[ "$(findmnt -n -o UUID --mountpoint "$storage")" == "$(blkid -s UUID -o value /dev/disk/by-id/google-campus-data)" ]]
[[ ! -L "$storage/$profile" ]]
if [[ ! -d "$storage/$profile" ]]; then
  install -d -m 0700 "$storage/$profile"
fi
[[ "$(realpath "$storage/$profile")" == "$storage/$profile" ]]

envfile="/etc/dbl-campus/$profile.env"
if [[ ! -e "$envfile" ]]; then
  tmp="$(mktemp /etc/dbl-campus/.profile.XXXXXX)"
  trap 'rm -f "$tmp"' EXIT
  image="$(cat "$runtime/image")"
  [[ "$image" =~ ^dbl-campus:[a-f0-9]{40}$ ]]
  setup_code="$(openssl rand -hex 32)"
  session_secret="$(openssl rand -hex 32)"
  printf '%s\n' 'APP_URL=https://campus.dblab.site' 'DOMAIN=campus.dblab.site' \
    "CAMPUS_IMAGE=$image" "CAMPUS_DATA_PATH=$storage/$profile" \
    "DBL_ADMIN_SETUP_CODE=$setup_code" "DBL_SESSION_SECRET=$session_secret" >"$tmp"
  mv -T "$tmp" "$envfile"
fi

cd "$runtime"
compose=(docker compose --project-name dbl-campus --env-file "$envfile"
  --file docker-compose.yml --file deploy/gce/compose.yml --file deploy/gce/compose.tunnel.yml)
up=(up -d --wait --wait-timeout 100 --no-build --pull never)
if [[ ${2:-} == --recreate-app ]]; then
  "${compose[@]}" "${up[@]}" --no-deps --force-recreate app
else
  "${compose[@]}" "${up[@]}"
fi
printf '%s\n' "$profile" >/etc/dbl-campus/active-profile
