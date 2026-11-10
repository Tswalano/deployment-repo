#!/usr/bin/env bash
# One-time AWS setup (run from a machine with admin AWS CLI creds). Idempotent.
#   1. lendify-instance-role  → instance profile on the EC2 box: read /apps/* params (+ SSM Session Manager)
#   2. github-deploy-repo-role → assumed by this repo's Actions (environment "production") via OIDC:
#      may only add/remove ingress rules on the instance's security group
set -Eeuo pipefail
cd "$(dirname "$0")/../infra/iam"
REGION="${AWS_REGION:-af-south-1}"
INSTANCE_NAME="${INSTANCE_NAME:-lendify-instance}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
INSTANCE_ID="$(aws ec2 describe-instances --region "$REGION" --filters "Name=tag:Name,Values=$INSTANCE_NAME" "Name=instance-state-name,Values=running,stopped" --query 'Reservations[0].Instances[0].InstanceId' --output text)"
SG_ID="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)"
render() { sed -e "s/\${ACCOUNT_ID}/$ACCOUNT_ID/g" -e "s/\${SG_ID}/$SG_ID/g" "$1"; }
exists() { aws iam get-role --role-name "$1" >/dev/null 2>&1; }
echo "account=$ACCOUNT_ID instance=$INSTANCE_ID sg=$SG_ID"

# --- 1. instance role
exists lendify-instance-role || aws iam create-role --role-name lendify-instance-role \
  --assume-role-policy-document "$(render instance-trust.json)" --description "lendify-instance: read /apps/* SSM parameters" >/dev/null
aws iam put-role-policy --role-name lendify-instance-role --policy-name read-app-secrets --policy-document "$(render instance-read-app-secrets.json)"
aws iam attach-role-policy --role-name lendify-instance-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam get-instance-profile --instance-profile-name lendify-instance-profile >/dev/null 2>&1 || {
  aws iam create-instance-profile --instance-profile-name lendify-instance-profile >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name lendify-instance-profile --role-name lendify-instance-role
  sleep 10   # IAM propagation
}
current="$(aws ec2 describe-iam-instance-profile-associations --region "$REGION" --filters "Name=instance-id,Values=$INSTANCE_ID" "Name=state,Values=associated" --query 'IamInstanceProfileAssociations[0].IamInstanceProfile.Arn' --output text)"
if [[ "$current" == None ]]; then
  aws ec2 associate-iam-instance-profile --region "$REGION" --instance-id "$INSTANCE_ID" --iam-instance-profile Name=lendify-instance-profile >/dev/null
  echo "✔ instance profile attached"
else
  echo "✔ instance already has profile: $current"
fi

# --- 2. GitHub Actions deploy role
exists github-deploy-repo-role || aws iam create-role --role-name github-deploy-repo-role \
  --assume-role-policy-document "$(render github-deploy-trust.json)" --description "Tswalano/deployment-repo Actions: temporary SSH ingress for the runner" >/dev/null
aws iam put-role-policy --role-name github-deploy-repo-role --policy-name sg-ssh-runner-ingress --policy-document "$(render github-deploy-sg-ssh.json)"
echo "✔ github-deploy-repo-role ready"
echo
echo "Add these to GitHub → Settings → Secrets and variables → Actions:"
echo "  secret   AWS_DEPLOY_ROLE_ARN = arn:aws:iam::$ACCOUNT_ID:role/github-deploy-repo-role"
echo "  variable DEPLOY_SG_ID        = $SG_ID"
