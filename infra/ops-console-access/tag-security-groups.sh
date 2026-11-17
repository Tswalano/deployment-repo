#!/usr/bin/env bash
# Let the Ops Console open temporary SSH (port 22) rules on the security groups of its managed instances.
# The console's IAM policy (infra/iam/instance-ops-console-access.json) only allows changing security groups
# tagged ops-console=managed; this tags the groups attached to instances tagged ops-console=managed.
#   ./infra/ops-console-access/tag-security-groups.sh [region] [--dry-run]
# Prints which instances use each group first. Nothing is ever untagged or changed otherwise.
set -Eeuo pipefail
REGION="${AWS_REGION:-af-south-1}"; DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) REGION="$a" ;; esac; done
mapfile -t SGS < <(aws ec2 describe-instances --region "$REGION" --filters Name=tag:ops-console,Values=managed \
  --query 'Reservations[].Instances[].SecurityGroups[].GroupId' --output text | tr '\t' '\n' | sort -u | grep . || true)
[[ ${#SGS[@]} -gt 0 ]] || { echo "no managed instances in $REGION"; exit 0; }
for sg in "${SGS[@]}"; do
  used="$(aws ec2 describe-instances --region "$REGION" --filters "Name=instance.group-id,Values=$sg" \
     --query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' ' ')"
  echo "$sg  used by: $used"
  ((DRY)) || aws ec2 create-tags --region "$REGION" --resources "$sg" --tags Key=ops-console,Value=managed
done
if ((DRY)); then echo "(dry run: nothing tagged)"; else echo "✔ tagged ${#SGS[@]} security group(s) ops-console=managed in $REGION"; fi
