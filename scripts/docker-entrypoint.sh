#!/bin/sh
set -eu
umask 077

case "${APP_URL:-}" in
  https://*) ;;
  *) echo 'APP_URL must be the public HTTPS origin' >&2; exit 1 ;;
esac
session_secret=${DBL_SESSION_SECRET:-}
setup_secret=${DBL_ADMIN_SETUP_CODE:-}
if [ "${#session_secret}" -lt 32 ] || [ "${#setup_secret}" -lt 32 ]; then
  echo 'Configure distinct session and first-run secrets with at least 32 characters' >&2
  exit 1
fi
if [ "$session_secret" = "$setup_secret" ]; then
  echo 'Use separate secrets for sessions and first-run setup' >&2
  exit 1
fi

# A newly attached cloud volume can be owned by root regardless of image metadata.
for dir in /data /data/uploads /data/releases /data/backups; do
  install -d -m 0700 -o node -g node "$dir"
done
exec gosu node "$@"
