#!/usr/bin/env bash
set -euo pipefail

component=system
scratch=''
finish() {
  local status=$?
  if [[ -n "$scratch" ]]; then
    rm -rf "$scratch"
  fi
  if (( status != 0 )); then
    printf 'DBL_CAMPUS_IPV6 FAIL %s\n' "$component" >/dev/ttyS0
  fi
}
trap finish EXIT

export DEBIAN_FRONTEND=noninteractive
timeout 150 apt-get -qq -o Acquire::ForceIPv6=true -o Acquire::Retries=0 -o APT::Update::Error-Mode=any update
timeout 120 apt-get -qq -o Acquire::ForceIPv6=true -o Acquire::Retries=0 install --no-install-recommends ca-certificates curl jq
printf 'DBL_CAMPUS_IPV6 PASS system\n' >/dev/ttyS0

component=docker-registry
scratch="$(mktemp -d)"
registry=https://registry-1.docker.io/v2/library/hello-world
request=(curl -6fsSL --connect-timeout 8 --max-time 20)
token="$("${request[@]}" 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/hello-world:pull' | jq -er '.token')"
manifest="$("${request[@]}" -H "Authorization: Bearer $token" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  "$registry/manifests/latest" | jq -er '.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest')"
layer="$("${request[@]}" -H "Authorization: Bearer $token" \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "$registry/manifests/$manifest" | jq -er '.layers[0].digest')"
[[ "$layer" =~ ^sha256:[a-f0-9]{64}$ ]]
"${request[@]}" --max-filesize 262144 -H "Authorization: Bearer $token" "$registry/blobs/$layer" -o "$scratch/layer"
printf '%s  %s\n' "${layer#sha256:}" "$scratch/layer" | sha256sum -c --status
printf 'DBL_CAMPUS_IPV6 PASS docker-registry\n' >/dev/ttyS0

component=cloudflare-edge
for hostname in region1.v2.argotunnel.com region2.v2.argotunnel.com; do
  ip="$(getent ahostsv6 "$hostname" | awk 'NR == 1 { print $1 }')"
  [[ "$ip" = *:* && "$ip" != ::ffff:* ]]
  timeout 8 bash -c 'exec 3<>/dev/tcp/"$1"/7844' _ "$ip"
done
printf 'DBL_CAMPUS_IPV6 PASS cloudflare-edge\n' >/dev/ttyS0
printf 'DBL_CAMPUS_IPV6 READY\n' >/dev/ttyS0
