#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != --apply || $# != 1 ]]; then
  echo 'Usage: provision-tunnel.sh --apply' >&2
  exit 2
fi

project=dbl-campus
region=us-central1
zone=us-central1-a
network=dbl-campus
iapsource=35.235.240.0/20
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

compute() {
  local action="$1 $2"
  if ! gcloud compute "$@" --project="$project" --quiet --format=json 2>"$scratch/gcloud.err"; then
    if [[ ${GITHUB_ACTIONS:-} != true ]]; then
      cat "$scratch/gcloud.err" >&2
    fi
    echo "Compute Engine operation failed: $action. Check the project's audit log." >&2
    return 1
  fi
}

require_json() {
  local message="$1"
  shift
  if ! jq -e "$@" >/dev/null; then
    echo "$message" >&2
    return 1
  fi
}

verify_vm() {
  compute instances describe "$network" --zone="$zone" | require_json 'The VM does not match the approved instance configuration.' '
    (.machineType | endswith("/e2-micro")) and ((.scheduling.provisioningModel // "STANDARD") == "STANDARD")
    and (.networkInterfaces | length == 1)
    and (.networkInterfaces[0] | (.network | endswith("/networks/dbl-campus"))
      and (.subnetwork | endswith("/regions/us-central1/subnetworks/dbl-campus"))
      and .stackType == "IPV4_IPV6" and ((.accessConfigs // []) | length == 0)
      and (.ipv6AccessConfigs | length == 1))
    and ((.serviceAccounts // []) | length == 0)
    and (.disks | length == 2)
    and any(.disks[]; .boot and (.source | endswith("/disks/dbl-campus")))
    and any(.disks[]; .deviceName == "campus-data" and .autoDelete == false
      and (.source | endswith("/disks/dbl-campus-data")))
    and any(.metadata.items[]; .key == "enable-oslogin" and (.value | ascii_upcase) == "TRUE")
  '
  compute disks describe "$network" --zone="$zone" | require_json 'Unexpected boot disk type or size.' '
    (.type | endswith("/pd-standard")) and (.sizeGb | tonumber) == 10'
  compute disks describe "$network-data" --zone="$zone" | require_json 'Unexpected data disk type or size.' '
    (.type | endswith("/pd-standard")) and (.sizeGb | tonumber) == 15'
  echo 'VM verified with external IPv6 and no public IPv4.'
}

instances="$(compute instances list)"
disks="$(compute disks list)"
if ! jq -e 'length == 0' <<<"$instances" >/dev/null; then
  require_json 'Another instance already exists. Review inventory before proceeding.' \
    --arg name "$network" --arg zone "/zones/$zone" \
    'length == 1 and (.[0] | .name == $name and (.zone | endswith($zone)))' <<<"$instances"
  require_json 'The existing VM has an unexpected project disk inventory.' \
    'map(.name) | sort == ["dbl-campus", "dbl-campus-data"]' <<<"$disks"
  echo 'The expected VM already exists. Verifying without modifying it.'
  verify_vm
  exit 0
fi
require_json 'A detached disk already exists. Review inventory before proceeding.' 'length == 0' <<<"$disks"

# Permit clean recovery after a previous attempt created the network only.
network_state="$(compute networks list | jq --arg name "$network" 'map(select(.name == $name))')"
if jq -e 'length == 0' <<<"$network_state" >/dev/null; then
  compute networks create "$network" --subnet-mode=custom >/dev/null
else
  require_json 'The existing Campus network is not in custom subnet mode.' \
    'length == 1 and (.[0].autoCreateSubnetworks // false) == false' <<<"$network_state"
fi
echo 'Campus network ready.'

subnet_state="$(compute networks subnets list | jq --arg name "$network" --arg region "/regions/$region" \
  'map(select(.name == $name and (.region | endswith($region))))')"
if jq -e 'length == 0' <<<"$subnet_state" >/dev/null; then
  compute networks subnets create "$network" --network="$network" --region="$region" \
    --range=10.70.0.0/24 --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL >/dev/null
else
  require_json 'The existing Campus subnet does not match the approved configuration.' \
    --arg suffix "/networks/$network" '
    length == 1 and (.[0] | (.network | endswith($suffix)) and .ipCidrRange == "10.70.0.0/24"
    and .stackType == "IPV4_IPV6" and .ipv6AccessType == "EXTERNAL")
  ' <<<"$subnet_state"
fi
echo 'Dual-stack Campus subnet ready.'

# Network self-links also contain the project ID. Compare the network name only.
firewall_state="$(compute firewall-rules list | jq --arg suffix "/networks/$network" \
  'map(select(.network | endswith($suffix)))')"
if jq -e 'length == 0' <<<"$firewall_state" >/dev/null; then
  compute firewall-rules create "$network-iap-ssh" --network="$network" \
    --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges="$iapsource" --target-tags="$network" >/dev/null
else
  require_json 'The existing Campus network has an unexpected firewall rule.' \
    --arg network "$network" --arg source "$iapsource" '
    length == 1 and (.[0] | .name == ($network + "-iap-ssh")
    and (.network | endswith("/networks/" + $network)) and .direction == "INGRESS"
    and .disabled != true and .sourceRanges == [$source] and .targetTags == [$network]
    and .allowed == [{IPProtocol: "tcp", ports: ["22"]}])
  ' <<<"$firewall_state"
fi
echo 'Only the expected IAP SSH ingress rule is configured on the Campus network.'

compute instances create "$network" --zone="$zone" --machine-type=e2-micro \
  --provisioning-model=STANDARD --reservation-affinity=none \
  --network-interface="network=$network,subnet=$network,stack-type=IPV4_IPV6,no-address,ipv6-network-tier=PREMIUM" \
  --no-service-account --no-scopes --tags="$network" \
  --metadata=enable-oslogin=TRUE --metadata-from-file="startup-script=$dir/probe-ipv6.sh" \
  --image-project=debian-cloud --image-family=debian-12 --boot-disk-type=pd-standard --boot-disk-size=10GB \
  --create-disk="name=$network-data,device-name=campus-data,type=pd-standard,size=15GB,auto-delete=no" >/dev/null
echo 'Compute Engine accepted VM creation.'
verify_vm
