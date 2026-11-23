#!/usr/bin/env bash
set -euo pipefail
umask 077
origin="${1:?Usage: export-encrypted-backup.sh HTTPS_ORIGIN AGE_RECIPIENT OUTPUT.age}"
recipient="${2:?An age public recipient is required}"
output="${3:?Choose an output file ending in .age}"
[[ "$output" == *.age && ! -e "$output" ]]
node --experimental-strip-types --input-type=module -e '
  import {validateProductionOrigin} from "./src/utils/productionOrigin.ts";
  if (validateProductionOrigin(process.argv[1]) !== process.argv[1]) process.exit(1);
' "$origin"

command -v age >/dev/null
read -rsp 'Representative bearer token: ' token
printf '\n' >&2
[[ "$token" =~ ^[a-f0-9]{64}$ ]]
temp=$(mktemp "${output}.XXXXXXXX")
trap 'rm -f "$temp"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$token" |
  curl --config - --proto '=https' --silent --show-error --fail --max-time 300 "$origin/api/admin/backup" |
  age --recipient "$recipient" --output "$temp"
ln "$temp" "$output"
