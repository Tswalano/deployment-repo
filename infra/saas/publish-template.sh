#!/usr/bin/env bash
# Publish the Connect-AWS CloudFormation template so customers get a one-click "quick create" link (Phase 12b).
#   ./infra/saas/publish-template.sh [--dry-run]
# Creates (once) a bucket ops-console-public-<account>-<region> whose bucket policy makes ONLY
# connect/connect-aws.json readable by anyone (CloudFormation fetches it from the customer's account; nothing else in
# the bucket is public), then uploads the template. Set CONNECT_TEMPLATE_URL in the multi-customer console to the
# URL printed at the end.
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
REGION="${AWS_REGION:-af-south-1}"; DRY=0; [[ "${1:-}" == --dry-run ]] && DRY=1
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="ops-console-public-$ACCOUNT-$REGION"; KEY="connect/connect-aws.json"
python3 infra/saas/build-connect-template.py
run() { if ((DRY)); then echo "  would run: $*"; else "$@"; fi; }
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  run aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration "LocationConstraint=$REGION"
  run aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"
  run aws s3api put-bucket-policy --bucket "$BUCKET" --policy \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TemplateAndBundlesOnly\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":[\"arn:aws:s3:::$BUCKET/$KEY\",\"arn:aws:s3:::$BUCKET/bundles/*\"]}]}"
fi
run aws s3 cp ops-console/api/assets/connect-aws.json "s3://$BUCKET/$KEY" --content-type application/json --cache-control "max-age=300"
echo "CONNECT_TEMPLATE_URL=https://$BUCKET.s3.$REGION.amazonaws.com/$KEY"

# the server release bundle (immutable: named by its checksum)
BUNDLE="$(bash infra/saas/build-bundle.sh | head -1)"; SHA="$(basename "$BUNDLE" .tar.gz)"
run aws s3 cp "$BUNDLE" "s3://$BUCKET/bundles/$SHA.tar.gz" --content-type application/gzip --cache-control "max-age=31536000, immutable"
echo "SERVER_BUNDLE_URL=https://$BUCKET.s3.$REGION.amazonaws.com/bundles/$SHA.tar.gz"
echo "SERVER_BUNDLE_SHA256=$SHA"
