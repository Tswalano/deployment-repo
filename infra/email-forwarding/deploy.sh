#!/usr/bin/env bash
# =============================================================================
# deploy.sh: inbound email for glenify.studio via SES (af-south-1). Idempotent.
#
#   ./infra/email-forwarding/deploy.sh                    # deploy / update
#   ./infra/email-forwarding/deploy.sh --replace-active   # allow replacing an active rule set that has rules
#
# Order (mail only starts arriving once everything can handle it):
#   1. CloudFormation stack (bucket, forwarder Lambda, rule set + rule)
#   2. upload forwarder.py
#   3. destination inbox in SSM (asked for, hidden, if missing; never stored in the repo)
#   4. activate the rule set
#   5. MX record glenify.studio → inbound-smtp.af-south-1.amazonaws.com (Route 53)
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")"
REGION="${AWS_REGION:-af-south-1}"
STACK="glenify-inbound-email"
DOMAIN="glenify.studio"
RULESET="glenify-inbound"
PARAM="/mail/$DOMAIN/FORWARD_TO"
REPLACE_ACTIVE=0; [[ "${1:-}" == "--replace-active" ]] && REPLACE_ACTIVE=1

echo "→ 1/5 stack $STACK"
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file template.yaml \
  --capabilities CAPABILITY_IAM --parameter-overrides Domain="$DOMAIN" RuleSetName="$RULESET" ForwardToParam="$PARAM" \
  --no-fail-on-empty-changeset

echo "→ 2/5 forwarder code"
BUILD="$(mktemp -d)"; trap 'rm -rf "$BUILD"' EXIT
cp forwarder.py "$BUILD/index.py"
python3 -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); z.write(sys.argv[2],"index.py"); z.close()' "$BUILD/f.zip" "$BUILD/index.py"
aws lambda update-function-code --region "$REGION" --function-name glenify-mail-forwarder --zip-file "fileb://$BUILD/f.zip" >/dev/null
aws lambda wait function-updated --region "$REGION" --function-name glenify-mail-forwarder

echo "→ 3/5 destination inbox ($PARAM)"
if aws ssm get-parameter --region "$REGION" --name "$PARAM" >/dev/null 2>&1; then
  echo "  already set"
else
  dest="${FORWARD_TO:-}"
  [[ -n "$dest" ]] || read -rp "  Forward mail for *@$DOMAIN to which inbox? " dest
  [[ "$dest" == *@*.* ]] || { echo "  not an email address" >&2; exit 1; }
  printf '%s' "$dest" | python3 -c 'import json,sys;print(json.dumps({"Value":sys.stdin.read()}))' > "$BUILD/p.json"
  aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString --cli-input-json "file://$BUILD/p.json" >/dev/null
  echo "  saved (SecureString)"
  echo "  ⚠ While SES is in the sandbox, this inbox must be a verified SES identity in $REGION."
fi

echo "→ 4/5 activate rule set $RULESET"
active="$(aws ses describe-active-receipt-rule-set --region "$REGION" --query 'Metadata.Name' --output text 2>/dev/null || echo None)"
if [[ "$active" == "$RULESET" ]]; then
  echo "  already active"
else
  rules="$(aws ses describe-active-receipt-rule-set --region "$REGION" --query 'length(Rules)' --output text 2>/dev/null || echo 0)"
  if [[ "$active" != None && "$rules" != 0 && $REPLACE_ACTIVE == 0 ]]; then
    echo "  ✘ '$active' is active with $rules rule(s); only one rule set can be active." >&2
    echo "    Review it, then re-run with --replace-active (or move its rules into $RULESET)." >&2
    exit 1
  fi
  aws ses set-active-receipt-rule-set --region "$REGION" --rule-set-name "$RULESET"
  echo "  activated (was: $active)"
fi

echo "→ 5/5 MX record"
ZONE="$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN." --query 'HostedZones[0].Id' --output text)"
cat > "$BUILD/mx.json" <<JSON
{"Comment":"SES inbound for $DOMAIN","Changes":[{"Action":"UPSERT","ResourceRecordSet":{
 "Name":"$DOMAIN","Type":"MX","TTL":300,"ResourceRecords":[{"Value":"10 inbound-smtp.$REGION.amazonaws.com"}]}}]}
JSON
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch "file://$BUILD/mx.json" --query 'ChangeInfo.Status' --output text
echo "✔ inbound email ready: mail to anything@$DOMAIN is forwarded (allow a few minutes for DNS)."
