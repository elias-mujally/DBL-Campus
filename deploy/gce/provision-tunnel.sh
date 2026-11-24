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

# A different instance or detached disk could use the remaining free allocation.
compute instances list >"$scratch/instances.json"
compute disks list >"$scratch/disks.json"
if ! jq -e 'length == 0' "$scratch/instances.json" >/dev/null ||
   ! jq -e 'length == 0' "$scratch/disks.json" >/dev/null; then
  echo 'An instance or a disk already exists. Review inventory before proceeding.' >&2
  exit 1
fi

# Permit clean recovery after a previous attempt created the network only.
network_state="$(compute networks list --filter="name=$network")"
if jq -e 'length == 0' <<<"$network_state" >/dev/null; then
  compute networks create "$network" --subnet-mode=custom >/dev/null
else
  jq -e --arg network "$network" 'length == 1 and .[0].name == $network and .[0].autoCreateSubnetworks == false' <<<"$network_state" >/dev/null
fi

subnet_state="$(compute networks subnets list --filter="name=$network AND region:($region)")"
if jq -e 'length == 0' <<<"$subnet_state" >/dev/null; then
  compute networks subnets create "$network" --network="$network" --region="$region" \
    --range=10.70.0.0/24 --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL >/dev/null
else
  jq -e --arg suffix "/networks/$network" --arg subnet "$network" --arg region "/regions/$region" '
    length == 1 and (.[0] | .name == $subnet and (.network | endswith($suffix))
    and (.region | endswith($region)) and .ipCidrRange == "10.70.0.0/24"
    and .stackType == "IPV4_IPV6" and .ipv6AccessType == "EXTERNAL")
  ' <<<"$subnet_state" >/dev/null
fi

firewall_state="$(compute firewall-rules list --filter="network:($network)")"
if jq -e 'length == 0' <<<"$firewall_state" >/dev/null; then
  compute firewall-rules create "$network-iap-ssh" --network="$network" \
    --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges="$iapsource" --target-tags="$network" >/dev/null
else
  jq -e --arg network "$network" --arg source "$iapsource" '
    length == 1 and (.[0] | .name == ($network + "-iap-ssh")
    and (.network | endswith("/networks/" + $network)) and .direction == "INGRESS"
    and .disabled != true and .sourceRanges == [$source] and .targetTags == [$network]
    and .allowed == [{IPProtocol: "tcp", ports: ["22"]}])
  ' <<<"$firewall_state" >/dev/null
fi

compute instances create "$network" --zone="$zone" --machine-type=e2-micro \
  --provisioning-model=STANDARD --reservation-affinity=none \
  --network-interface="network=$network,subnet=$network,stack-type=IPV4_IPV6,no-address,ipv6-network-tier=PREMIUM" \
  --no-service-account --no-scopes --tags="$network" \
  --metadata=enable-oslogin=TRUE --metadata-from-file="startup-script=$dir/probe-ipv6.sh" \
  --image-project=debian-cloud --image-family=debian-12 --boot-disk-type=pd-standard --boot-disk-size=10GB \
  --create-disk="name=$network-data,device-name=campus-data,type=pd-standard,size=15GB,auto-delete=no" >/dev/null

compute instances describe "$network" --zone="$zone" | jq -e '
  (.machineType | endswith("/e2-micro")) and (.scheduling.provisioningModel == "STANDARD")
  and (.networkInterfaces | length == 1)
  and (.networkInterfaces[0] | .stackType == "IPV4_IPV6"
    and ((.accessConfigs // []) | length == 0)
    and (.ipv6AccessConfigs | length == 1))
  and ((.serviceAccounts // []) | length == 0)
  and (.disks | length == 2)
  and any(.disks[]; .deviceName == "campus-data" and .autoDelete == false)
' >/dev/null

compute disks describe "$network" --zone="$zone" | jq -e '
  (.type | endswith("/pd-standard")) and (.sizeGb | tonumber) == 10
' >/dev/null
compute disks describe "$network-data" --zone="$zone" | jq -e '
  (.type | endswith("/pd-standard")) and (.sizeGb | tonumber) == 15
' >/dev/null
echo 'VM created and verified with external IPv6 and no public IPv4.'
