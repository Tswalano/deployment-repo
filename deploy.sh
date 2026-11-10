#!/usr/bin/env bash
# =============================================================================
# deploy.sh — run from your laptop or CI. Ships this repo's pipeline to the
# server and executes it there.
#
#   ./deploy.sh status   all
#   ./deploy.sh deploy   all
#   ./deploy.sh deploy   liftparcel [git-ref]
#   ./deploy.sh rollback liftparcel [git-sha]
#   ./deploy.sh history  lendify
#   ./deploy.sh restore-snapshot lendify [snapshot-file]
#   ./deploy.sh secrets-cutover all            (one-time: move secrets to SSM)
#   ./deploy.sh ops-dashboard install          (read-only status page on 127.0.0.1:9100)
#   ./deploy.sh ops-dashboard expose ops.glenify.studio
#
# Connection (env vars, or put them in a git-ignored .deploy.env):
#   DEPLOY_HOST       server hostname/IP                      (required)
#   DEPLOY_USER       default: ec2-user
#   DEPLOY_SSH_KEY    path to private key                     (option A)
#   EC2_INSTANCE_ID   use EC2 Instance Connect + AWS CLI creds (option B, no .pem needed)
#   AWS_REGION        default: af-south-1
#   REMOTE_DIR        where the pipeline lives on the server, default: /opt/deploy
# Any of FORCE / SKIP_DB_BACKUP / NO_AUTO_ROLLBACK are forwarded to the server.
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[[ -f .deploy.env ]] && source .deploy.env

: "${DEPLOY_HOST:?set DEPLOY_HOST (see header of $0)}"
DEPLOY_USER="${DEPLOY_USER:-ec2-user}"
REMOTE_DIR="${REMOTE_DIR:-/opt/deploy}"
AWS_REGION="${AWS_REGION:-af-south-1}"
(($#)) || { sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new)

if [[ -n "${EC2_INSTANCE_ID:-}" ]]; then
  # Option B: push a throwaway key with EC2 Instance Connect (valid 60s per push)
  TMPKEY="$(mktemp -d)/key"; trap 'rm -rf "$(dirname "$TMPKEY")"' EXIT
  ssh-keygen -q -t ed25519 -N '' -f "$TMPKEY"
  DEPLOY_SSH_KEY="$TMPKEY"
  push_key() {
    aws ec2-instance-connect send-ssh-public-key --region "$AWS_REGION" \
      --instance-id "$EC2_INSTANCE_ID" --instance-os-user "$DEPLOY_USER" \
      --ssh-public-key "file://$TMPKEY.pub" >/dev/null
  }
else
  : "${DEPLOY_SSH_KEY:?set DEPLOY_SSH_KEY or EC2_INSTANCE_ID}"
  push_key() { :; }
fi
SSH_OPTS+=(-i "$DEPLOY_SSH_KEY")
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

echo "→ syncing pipeline to $TARGET:$REMOTE_DIR"
push_key
ssh "${SSH_OPTS[@]}" "$TARGET" "sudo mkdir -p '$REMOTE_DIR' && sudo chown \$(id -un) '$REMOTE_DIR'"
push_key
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" server projects systemd ops-dashboard templates "$TARGET:$REMOTE_DIR/"

ENV_FWD=""
# who/what triggered this run, shown on the ops dashboard
DEPLOY_ACTOR="${DEPLOY_ACTOR:-$(git config user.name 2>/dev/null || id -un) (local)}"
DEPLOY_TRIGGER="${DEPLOY_TRIGGER:-cli}"
for v in FORCE SKIP_DB_BACKUP NO_AUTO_ROLLBACK HEALTH_TIMEOUT DEPLOY_ACTOR DEPLOY_TRIGGER DEPLOY_RUN_URL; do
  [[ -n "${!v:-}" ]] && ENV_FWD+="$v=$(printf %q "${!v}") "
done
ARGS="$(printf '%q ' "$@")"

echo "→ running: pipeline.sh $*"
push_key
ssh -t "${SSH_OPTS[@]}" "$TARGET" "${ENV_FWD}bash '$REMOTE_DIR/server/pipeline.sh' $ARGS"
