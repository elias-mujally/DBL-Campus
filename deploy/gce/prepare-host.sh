#!/usr/bin/env bash
# Prepare the dedicated DBL Campus data disk and Docker on the approved Debian VM.
set -euo pipefail

[[ $EUID == 0 ]] || { echo 'Run on the Campus VM as root.' >&2; exit 2; }
source /etc/os-release
[[ "$ID" == debian && "$VERSION_CODENAME" == bookworm && "$(dpkg --print-architecture)" == amd64 ]]
device=/dev/disk/by-id/google-campus-data
data=/srv/dbl-campus-data
[[ -b "$device" && "$(lsblk -nr -o TYPE "$device")" == disk ]] || {
  echo 'Expected an unpartitioned Campus data disk.' >&2
  exit 1
}
if lsblk -nr -o MOUNTPOINT "$device" | grep -vFx -e '' -e "$data" | grep -q .; then
  echo 'The data disk is mounted at an unexpected location.' >&2
  exit 1
fi

filesystem="$(lsblk -dn -o FSTYPE "$device")"
if [[ -z "$filesystem" ]]; then
  signatures="$(wipefs --noheadings --output TYPE "$device")"
  [[ -z "$signatures" ]] || {
    echo 'The data disk has an existing signature.' >&2
    exit 1
  }
  mkfs.ext4 -q -L dbl-campus-data "$device"
elif [[ "$filesystem" != ext4 ]]; then
  echo 'The data disk already has an unexpected filesystem.' >&2
  exit 1
fi

uuid="$(blkid -s UUID -o value "$device")"
[[ -n "$uuid" ]]
if mountpoint -q "$data"; then
  [[ "$(findmnt -n -o UUID --mountpoint "$data")" == "$uuid" ]]
else
  install -d -m 0750 "$data"
  [[ -z "$(find "$data" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo 'The unmounted Campus directory already contains files.' >&2
    exit 1
  }
fi
entry="UUID=$uuid $data ext4 defaults,nodev,nosuid 0 2"
existing="$(awk -v directory="$data" '$2 == directory && $1 !~ /^#/' /etc/fstab)"
if [[ -z "$existing" ]]; then
  printf '\n%s\n' "$entry" >>/etc/fstab
  systemctl daemon-reload
elif [[ "$existing" != "$entry" ]]; then
  echo 'An unexpected Campus mount entry is present in fstab.' >&2
  exit 1
fi
mountpoint -q "$data" || mount "$data"
[[ "$(findmnt -n -o UUID --mountpoint "$data")" == "$uuid" ]]

install -d -m 0755 /etc/systemd/system/docker.service.d
cat >/etc/systemd/system/docker.service.d/dbl-campus-data.conf <<'UNIT'
[Unit]
RequiresMountsFor=/srv/dbl-campus-data
UNIT
systemctl daemon-reload

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  install -d -m 0755 /etc/apt/keyrings
  key="$(mktemp)"
  trap 'rm -f "$key"' EXIT
  curl -6fsS --retry 2 --connect-timeout 10 --max-time 45 https://download.docker.com/linux/debian/gpg -o "$key"
  install -m 0644 "$key" /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/dbl-campus-docker.sources <<'SOURCES'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: bookworm
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
  apt-get -q -o Acquire::ForceIPv6=true -o APT::Update::Error-Mode=any update
  apt-get -q -y -o Acquire::ForceIPv6=true install --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

version="$(docker compose version --short)"
dpkg --compare-versions "${version#v}" ge 2.24.4
systemctl enable --now docker.service
install -d -m 0700 /etc/dbl-campus /opt/dbl-campus
printf 'PASS: persistent Campus data disk and Docker Compose %s\n' "$version"
