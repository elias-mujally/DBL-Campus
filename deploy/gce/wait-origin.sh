#!/usr/bin/env bash
set -euo pipefail

for attempt in {1..20}; do
  if curl -q --noproxy '*' -fsS --connect-timeout 1 --max-time 2 \
    http://127.0.0.1:8080/api/health 2>/dev/null | jq -e '
      .status == "ok" and .database == "ok" and .storageWritable and .httpsEnforced and (.demoEnabled == false)
    ' >/dev/null; then
    echo 'PASS: Caddy loopback origin and Campus health.'
    exit 0
  fi
  sleep 2
done

echo 'The Caddy origin on 127.0.0.1:8080 did not become ready.' >&2
curl -q --noproxy '*' -sS --connect-timeout 2 --max-time 4 -o /dev/null \
  -w 'Caddy loopback HTTP %{http_code}\n' http://127.0.0.1:8080/api/health || true
exit 1
