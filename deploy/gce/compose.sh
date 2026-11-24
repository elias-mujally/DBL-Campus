#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root. Compose env file contains secrets and stays outside Git.
envfile="${CAMPUS_ENV_FILE:?Set CAMPUS_ENV_FILE to the private deployment env file}"
[[ -r "$envfile" ]]
[[ "$(stat -c '%a' "$envfile")" =~ ^[0-6]00$ ]] || { echo "Protect the deployment env file with chmod 600" >&2; exit 2; }
[[ "${CAMPUS_DATA_PATH:-}" = /* ]] && mountpoint -q "$CAMPUS_DATA_PATH" ||
  { echo "CAMPUS_DATA_PATH must point to the mounted persistent disk" >&2; exit 2; }
files=(-f docker-compose.yml -f deploy/gce/compose.yml)
case "${CAMPUS_INGRESS:-tunnel}" in
  tunnel) files+=(-f deploy/gce/compose.tunnel.yml) ;;
  direct-ipv6) ;;
  *) echo "CAMPUS_INGRESS must be tunnel or direct-ipv6" >&2; exit 2 ;;
esac
docker compose --env-file "$envfile" "${files[@]}" up -d --wait --no-build --pull missing
