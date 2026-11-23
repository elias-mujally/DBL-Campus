#!/usr/bin/env bash
# Print commands for review. Run these only in the approved, authenticated project.
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 PROJECT_ID {tunnel|direct-ipv6}" >&2
  exit 2
fi
project="$1"
mode="$2"
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo "Invalid project ID" >&2; exit 2; }
case "$mode" in tunnel|direct-ipv6) ;; *) echo "Choose tunnel or direct-ipv6" >&2; exit 2 ;; esac
prefix=dbl-campus
region=us-central1
zone=us-central1-a

cat <<PLAN
# Review existing usage across the billing account and set a scoped budget first.
# Enable only Compute Engine and IAP APIs. Configure OS Login permissions before SSH.
gcloud services enable compute.googleapis.com iap.googleapis.com --project=$project
gcloud compute networks create $prefix --subnet-mode=custom --project=$project
gcloud compute networks subnets create $prefix --network=$prefix --region=$region --range=10.70.0.0/24 --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL --project=$project
gcloud compute firewall-rules create $prefix-iap-ssh --network=$prefix --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=$prefix --project=$project
PLAN
if [[ "$mode" == direct-ipv6 ]]; then
  printf '%s\n' "gcloud compute firewall-rules create $prefix-web-v6 --network=$prefix --direction=INGRESS --action=ALLOW --rules=tcp:80,tcp:443 --source-ranges=::/0 --target-tags=$prefix --project=$project"
fi
cat <<PLAN
gcloud compute instances create $prefix --project=$project --zone=$zone --machine-type=e2-micro --provisioning-model=STANDARD --network-interface=network=$prefix,subnet=$prefix,stack-type=IPV4_IPV6,no-address,ipv6-network-tier=PREMIUM --no-service-account --no-scopes --tags=$prefix --metadata=enable-oslogin=TRUE --image-project=debian-cloud --image-family=debian-12 --boot-disk-type=pd-standard --boot-disk-size=10GB --create-disk=name=$prefix-data,device-name=campus-data,type=pd-standard,size=15GB,auto-delete=no
gcloud compute ssh $prefix --project=$project --zone=$zone --tunnel-through-iap
PLAN
