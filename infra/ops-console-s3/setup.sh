#!/usr/bin/env bash
# Private S3 bucket the Ops Console uses to hand a backup file to an admin's browser.
#   ./infra/ops-console-s3/setup.sh [region]          (idempotent)
# - name ops-console-transfer-<account>-<region>; public access blocked; SSE-S3; TLS-only bucket policy
# - objects under downloads/ expire after 1 day (links themselves last 5 minutes)
# - the bucket name is stored in SSM /apps/ops-console/TRANSFER_BUCKET (read by app-secrets@ops-console)
# - instance role may put/get only downloads/* (infra/iam/instance-ops-console-transfer.json)
set -Eeuo pipefail
REGION="${1:-${AWS_REGION:-af-south-1}}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="ops-console-transfer-$ACCOUNT_ID-$REGION"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  echo "created s3://$BUCKET"
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-downloads","Status":"Enabled","Filter":{"Prefix":"downloads/"},"Expiration":{"Days":1},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Sid":"TlsOnly","Effect":"Deny","Principal":"*","Action":"s3:*",
 "Resource":["arn:aws:s3:::$BUCKET","arn:aws:s3:::$BUCKET/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
JSON
)"
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=managed-by,Value=deployment-repo}]'

cd "$(dirname "$0")/../iam"
aws iam put-role-policy --role-name lendify-instance-role --policy-name ops-console-transfer \
  --policy-document "$(sed -e "s/\${BUCKET}/$BUCKET/g" instance-ops-console-transfer.json)"
aws ssm put-parameter --region "$REGION" --name /apps/ops-console/TRANSFER_BUCKET --type String --value "$BUCKET" --overwrite >/dev/null
echo "✔ s3://$BUCKET ready (private, encrypted, TLS-only, downloads/ expire after 1 day)"
