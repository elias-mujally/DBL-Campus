#!/usr/bin/env bash
set -eu
tracked="$(git ls-files -- 'data/**' '*.db' '*.db-*' '*.sqlite' '*.sqlite-*')"
if [ -n "$tracked" ]; then
  printf 'Operational files are tracked:\n%s\n' "$tracked" >&2
  exit 1
fi
git check-ignore -q data/uploads/lecture.pdf
git check-ignore -q export.sqlite-wal
printf 'PASS: operational data is ignored and absent from the Git index\n'
