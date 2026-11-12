#!/usr/bin/env bash
# Point the admin SSH rule (port 22) at your *current* public IP.
# Home/office IPs drift; run this when ./deploy.sh or ssh starts timing out.
#   ./scripts/allow-my-ip.sh            # replace previous admin entries with your current IP
#   ./scripts/allow-my-ip.sh --dry-run  # show what would change
# Only touches rules whose description starts with "admin-ssh"; the EC2 Instance Connect
# prefix list and temporary GitHub Actions entries are left alone.
set -Eeuo pipefail
REGION="${AWS_REGION:-af-south-1}"
INSTANCE_NAME="${INSTANCE_NAME:-lendify-instance}"
LABEL="${LABEL:-admin-ssh}"
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

SG_ID="${SG_ID:-$(aws ec2 describe-instances --region "$REGION" --filters "Name=tag:Name,Values=$INSTANCE_NAME" \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)}"
IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not determine public IP" >&2; exit 1; }

# existing admin entries (also adopts the original hand-made "Glen - admin SSH" rule)
mapfile -t OLD < <(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" --output text \
  --query "SecurityGroups[0].IpPermissions[?FromPort==\`22\`].IpRanges[] | [?starts_with(Description||'', '$LABEL') || contains(Description||'', 'admin SSH')].CidrIp" | tr '\t' '\n' | grep . || true)

echo "security group: $SG_ID   your IP: $IP/32"
if printf '%s\n' "${OLD[@]}" | grep -qx "$IP/32"; then
  echo "✔ already allowed"; STALE=("${OLD[@]/$IP\/32}")
else
  echo "+ allow $IP/32"
  ((DRY)) || aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$IP/32,Description=$LABEL $(date -u +%F)}]" >/dev/null
  STALE=("${OLD[@]}")
fi
for cidr in "${STALE[@]}"; do
  [[ -n "$cidr" && "$cidr" != "$IP/32" ]] || continue
  echo "- remove stale $cidr"
  ((DRY)) || aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$cidr}]" >/dev/null
done
((DRY)) && echo "(dry run — nothing changed)"
aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" --output text \
  --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].[IpRanges[].[CidrIp,Description],PrefixListIds[].PrefixListId]' | sed 's/^/  port 22: /'
