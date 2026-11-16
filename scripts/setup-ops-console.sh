#!/usr/bin/env bash
# =============================================================================
# setup-ops-console.sh: run from your laptop (admin AWS CLI). Idempotent.
#   ./scripts/setup-ops-console.sh                 # DB secret (if missing) + install on the box
#   ./scripts/setup-ops-console.sh set-admin admin # create/reset an admin; password asked (hidden)
#
# The admin password is sent over SSH stdin and only ever stored as a scrypt hash in the database.
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-af-south-1}"
PARAM=/apps/ops-console/DATABASE_URL
export DEPLOY_HOST="${DEPLOY_HOST:-lendifyapi.glenify.studio}" EC2_INSTANCE_ID="${EC2_INSTANCE_ID:-i-0ff6700ee62757508}"

if [[ "${1:-}" == set-admin ]]; then
  user="${2:?usage: set-admin <username>}"
  if [[ -z "${ADMIN_PASSWORD:-}" ]]; then read -rsp "Password for $user (min 8 chars): " ADMIN_PASSWORD; echo; fi
  key="$(mktemp -d)/k"; ssh-keygen -q -t ed25519 -N '' -f "$key"
  aws ec2-instance-connect send-ssh-public-key --region "$REGION" --instance-id "$EC2_INSTANCE_ID" \
    --instance-os-user ec2-user --ssh-public-key "file://$key.pub" >/dev/null
  printf '%s' "$ADMIN_PASSWORD" | ssh -q -i "$key" -o StrictHostKeyChecking=accept-new "ec2-user@$DEPLOY_HOST" \
    "sudo bash -c 'set -a; . /run/app-secrets/ops-console.env; set +a; cd /opt/ops-console/api && exec node dist/cli.js set-admin $user'"
  rm -rf "$(dirname "$key")"; unset ADMIN_PASSWORD
  exit 0
fi

if aws ssm get-parameter --region "$REGION" --name "$PARAM" >/dev/null 2>&1; then
  echo "✔ $PARAM exists"
else
  pw="$(python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(40)))')"
  printf 'postgresql://opsconsole:%s@127.0.0.1:5432/opsconsole' "$pw" \
    | python3 -c 'import json,sys;print(json.dumps({"Value":sys.stdin.read()}))' > /tmp/.oc.json
  aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString --cli-input-json file:///tmp/.oc.json >/dev/null
  rm -f /tmp/.oc.json; unset pw
  echo "✔ created $PARAM (random 40-char password)"
fi

./deploy.sh ops-console install
echo
echo "Next: ./scripts/setup-ops-console.sh set-admin <username>"
echo "Try it: ssh -L 9200:127.0.0.1:9200 ec2-user@$DEPLOY_HOST   → http://localhost:9200"
