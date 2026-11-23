#!/usr/bin/env bash
set -euo pipefail
path="${CAMPUS_DATA_PATH:?Set CAMPUS_DATA_PATH to the mounted data directory}"
mountpoint -q "$path" || { echo "Data directory is not a mount point" >&2; exit 1; }
date --utc --iso-8601=seconds
printf '\nHost memory\n'
free -m
printf '\nHost CPU (first row is the since-boot average)\n'
vmstat 1 4
printf '\nStorage\n'
df -hP / "$path"
printf '\nContainers\n'
docker stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} RAM={{.MemUsage}} net={{.NetIO}} block={{.BlockIO}}'
