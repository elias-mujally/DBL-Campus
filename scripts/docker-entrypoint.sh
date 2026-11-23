#!/bin/sh
set -eu
umask 077

case "${APP_URL:-}" in
  https://*) ;;
  *) echo 'APP_URL must be the public HTTPS origin' >&2; exit 1 ;;
esac
if [ "${#DBL_SESSION_SECRET}" -lt 32 ] || [ "${#DBL_ADMIN_SETUP_CODE}" -lt 32 ]; then
  echo 'Configure distinct session and first-run secrets with at least 32 characters' >&2
  exit 1
fi
if [ "$DBL_SESSION_SECRET" = "$DBL_ADMIN_SETUP_CODE" ]; then
  echo 'Use separate secrets for sessions and first-run setup' >&2
  exit 1
fi

# A newly attached cloud volume can be owned by root regardless of image metadata.
for dir in /data /data/uploads /data/releases /data/backups; do
  install -d -m 0700 -o node -g node "$dir"
done
exec gosu node "$@"
