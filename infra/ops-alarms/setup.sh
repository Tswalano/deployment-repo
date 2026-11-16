#!/usr/bin/env bash
# External safety net for what the Ops Console can't report itself: the whole instance failing.
# The console runs ON the instance, so if the box hangs it can't send anything. CloudWatch can.
#   ./infra/ops-alarms/setup.sh <alert-email>   (idempotent; the address must confirm the SNS subscription)
# Creates: SNS topic "ops-alerts" + email subscription, and an alarm on StatusCheckFailed for the
# instance. A stopped instance reports no data, which counts as OK, so the daily 16:00–04:00 UTC
# shutdown never pages anyone.
set -Eeuo pipefail
EMAIL="${1:?usage: setup.sh <alert-email>}"
REGION="${AWS_REGION:-af-south-1}"
INSTANCE_NAME="${INSTANCE_NAME:-lendify-instance}"
ID="$(aws ec2 describe-instances --region "$REGION" --filters "Name=tag:Name,Values=$INSTANCE_NAME" \
      "Name=instance-state-name,Values=running,stopped" --query 'Reservations[0].Instances[0].InstanceId' --output text)"
[[ "$ID" == i-* ]] || { echo "instance $INSTANCE_NAME not found" >&2; exit 1; }

TOPIC="$(aws sns create-topic --region "$REGION" --name ops-alerts --tags Key=managed-by,Value=deployment-repo --query TopicArn --output text)"
if ! aws sns list-subscriptions-by-topic --region "$REGION" --topic-arn "$TOPIC" \
      --query "Subscriptions[?Protocol=='email' && Endpoint=='$EMAIL'] | length(@)" --output text | grep -q '^[1-9]'; then
  aws sns subscribe --region "$REGION" --topic-arn "$TOPIC" --protocol email --notification-endpoint "$EMAIL" >/dev/null
  echo "→ subscription created: confirm it from the email AWS just sent"
fi

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name "$INSTANCE_NAME-status-check-failed" \
  --alarm-description "Ops: $INSTANCE_NAME failed its EC2 status checks (hung or unreachable). Managed by deployment-repo." \
  --namespace AWS/EC2 --metric-name StatusCheckFailed --dimensions "Name=InstanceId,Value=$ID" \
  --statistic Maximum --period 60 --evaluation-periods 3 --datapoints-to-alarm 3 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC" --ok-actions "$TOPIC"
echo "✔ alarm $INSTANCE_NAME-status-check-failed → SNS ops-alerts"
