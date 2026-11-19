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
#   ./deploy.sh ops-console install            (Ops Console app on 127.0.0.1:9200; see scripts/setup-ops-console.sh)
#   ./deploy.sh ops-console expose ops.glenify.studio   (public HTTPS for the console; retires the old dashboard vhost)
#   ./scripts/deploy-staging.sh                (the qa branch at staging.glenify.studio, a separate copy next to production)
#   ./deploy.sh ops-dashboard expose ops.glenify.studio
#
# Connection (env vars, or put them in a git-ignored .deploy.env):
#   DEPLOY_HOST       server hostname/IP                      (required)
#   DEPLOY_USER       default: ec2-user
#   DEPLOY_SSH_KEY    path to private key                     (option A)
#   EC2_INSTANCE_ID   use EC2 Instance Connect + AWS CLI creds (option B, no .pem needed)
#   AWS_REGION        default: af-south-1
#   REMOTE_DIR        where the pipeline lives on the server, default: /opt/deploy
#   DEPLOY_VIA        auto (default): SSH, or AWS Systems Manager when SSH can't connect (some networks block
#                     port 22); ssh or ssm to force one. SSM needs EC2_INSTANCE_ID and an S3 bucket for a short-lived
#                     bundle: DEPLOY_BUCKET, or the console's /apps/ops-console/TRANSFER_BUCKET parameter.
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

ENV_FWD=""
# who/what triggered this run, shown on the ops dashboard
DEPLOY_ACTOR="${DEPLOY_ACTOR:-$(git config user.name 2>/dev/null || id -un) (local)}"
DEPLOY_TRIGGER="${DEPLOY_TRIGGER:-cli}"
for v in FORCE SKIP_DB_BACKUP NO_AUTO_ROLLBACK HEALTH_TIMEOUT DEPLOY_ACTOR DEPLOY_TRIGGER DEPLOY_RUN_URL INSTANCE OPS_PORT OPS_DB OPS_ORIGIN; do
  [[ -n "${!v:-}" ]] && ENV_FWD+="$v=$(printf %q "${!v}") "
done
ARGS="$(printf '%q ' "$@")"
SYNC_DIRS=(server projects systemd ops-dashboard ops-console templates)

# ---------------------------------------------------------------------------- transport: SSH, or SSM over HTTPS
VIA="${DEPLOY_VIA:-auto}"
if [[ "$VIA" == auto ]]; then
  push_key
  if ssh -o ConnectTimeout=10 "${SSH_OPTS[@]}" "$TARGET" true 2>/dev/null; then VIA=ssh
  else VIA=ssm; echo "→ SSH can't connect from this network: using AWS Systems Manager (HTTPS) instead"; fi
fi

# Same steps as the SSH path below, through Systems Manager: the files go up as a bundle in S3 (the server fetches it
# with a link valid 15 minutes, which also sits in the SSM command history until then), are synced into REMOTE_DIR,
# and pipeline.sh runs as DEPLOY_USER with the same forwarded settings. The bundle is deleted afterwards.
deploy_via_ssm() {
  : "${EC2_INSTANCE_ID:?the Systems Manager fallback needs EC2_INSTANCE_ID}"
  local bucket="${DEPLOY_BUCKET:-}"
  [[ -n "$bucket" ]] || bucket="$(aws ssm get-parameter --region "$AWS_REGION" --name /apps/ops-console/TRANSFER_BUCKET --with-decryption --query Parameter.Value --output text 2>/dev/null || true)"
  [[ -n "$bucket" && "$bucket" != None ]] || { echo "✘ set DEPLOY_BUCKET: an S3 bucket the deploy can use for a short-lived bundle" >&2; exit 1; }
  local work key url cid status=""
  work="$(mktemp -d)"; key="deploy-bundles/$(date +%Y%m%d-%H%M%S)-$$.tgz"
  trap 'aws s3 rm --quiet "s3://'"$bucket"'/'"$key"'" 2>/dev/null || true; rm -rf "'"$work"'" "'"$(dirname "${TMPKEY:-/nonexistent/x}")"'"' EXIT
  tar -czf "$work/bundle.tgz" --exclude node_modules --exclude dist "${SYNC_DIRS[@]}"
  echo "→ uploading the pipeline ($(du -h "$work/bundle.tgz" | cut -f1)) for $EC2_INSTANCE_ID"
  aws s3 cp --quiet "$work/bundle.tgz" "s3://$bucket/$key"
  url="$(aws s3 presign "s3://$bucket/$key" --region "$AWS_REGION" --expires-in 900)"
  local dirs=""; for d in "${SYNC_DIRS[@]}"; do dirs+="\"\$d/x/$d\" "; done
  cat > "$work/remote.sh" <<REMOTE
set -euo pipefail
d=\$(mktemp -d); trap 'rm -rf "\$d"' EXIT
curl -fsS -o "\$d/bundle.tgz" '$url'
mkdir "\$d/x"; tar -xzf "\$d/bundle.tgz" -C "\$d/x"
mkdir -p '$REMOTE_DIR'
rsync -a --delete --exclude node_modules --exclude dist $dirs '$REMOTE_DIR/'
chown -R '$DEPLOY_USER' '$REMOTE_DIR'
cd /
sudo -u '$DEPLOY_USER' -H env ${ENV_FWD}bash '$REMOTE_DIR/server/pipeline.sh' $ARGS
REMOTE
  python3 -c 'import json,sys; print(json.dumps({"commands": open(sys.argv[1]).read().split("\n"), "executionTimeout": ["3600"]}))' "$work/remote.sh" > "$work/params.json"
  echo "→ running via SSM: pipeline.sh $*"
  cid="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID" --document-name AWS-RunShellScript \
          --comment "deploy.sh $*" --timeout-seconds 600 --parameters "file://$work/params.json" --query Command.CommandId --output text)"
  rm -f "$work/remote.sh" "$work/params.json"
  while :; do
    status="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$cid" --instance-id "$EC2_INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Success|Failed|Cancelled|TimedOut) break ;; esac
    sleep 5
  done
  # SSM keeps the first 24,000 characters of each stream
  aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$cid" --instance-id "$EC2_INSTANCE_ID" --query StandardOutputContent --output text
  local err; err="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$cid" --instance-id "$EC2_INSTANCE_ID" --query StandardErrorContent --output text)"
  [[ -n "$err" && "$err" != None ]] && echo "$err" >&2
  [[ "$status" == Success ]] || { echo "✘ the run ended: $status" >&2; exit 1; }
}
if [[ "$VIA" == ssm ]]; then deploy_via_ssm "$@"; exit 0; fi

echo "→ syncing pipeline to $TARGET:$REMOTE_DIR"
push_key
ssh "${SSH_OPTS[@]}" "$TARGET" "sudo mkdir -p '$REMOTE_DIR' && sudo chown \$(id -un) '$REMOTE_DIR'"
push_key
rsync -az --delete --exclude node_modules --exclude dist -e "ssh ${SSH_OPTS[*]}" "${SYNC_DIRS[@]}" "$TARGET:$REMOTE_DIR/"

echo "→ running: pipeline.sh $*"
push_key
ssh -t "${SSH_OPTS[@]}" "$TARGET" "${ENV_FWD}bash '$REMOTE_DIR/server/pipeline.sh' $ARGS"
