#!/usr/bin/env bash
# =============================================================================
# deploy-staging.sh: the QA copy of the Ops Console at https://staging.glenify.studio (run from your laptop).
#   ./scripts/deploy-staging.sh                      # deploy the qa branch to staging (install = build + DB + service)
#   ./scripts/deploy-staging.sh expose               # nginx + HTTPS for staging.glenify.studio (DNS A record first)
#   ./scripts/deploy-staging.sh set-admin <username> # create/reset a staging admin; password asked (hidden)
#   ./scripts/deploy-staging.sh platform-admin <username> on|off   # staging platform owner portal
#
# Staging runs next to production on the same server but shares nothing that matters: its own service
# (ops-console-staging, port 9210), database (opsconsole_staging), settings (SSM /apps/ops-console-staging/*),
# nginx vhost and copy of the pipeline (/opt/deploy-staging). Production (/opt/deploy, /opt/ops-console) is never touched.
# Only the qa branch is deployed here, exactly as pushed: features wait on qa for sign-off before they go to main.
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .deploy.env ]] && source .deploy.env
REGION="${AWS_REGION:-af-south-1}"
DOMAIN=staging.glenify.studio
export INSTANCE=ops-console-staging OPS_PORT=9210 OPS_DB=opsconsole_staging OPS_ORIGIN="https://$DOMAIN" REMOTE_DIR=/opt/deploy-staging
PARAM="/apps/$INSTANCE/DATABASE_URL"
cmd="${1:-install}"

if [[ "$cmd" == install || "$cmd" == expose ]]; then
  [[ "$(git branch --show-current)" == qa ]] || { echo "Check out the qa branch first: staging only runs qa." >&2; exit 1; }
  git fetch -q origin qa
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/qa)" ]] || { echo "Local qa differs from origin/qa: pull (or push) first, so staging runs what's on GitHub." >&2; exit 1; }
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "Uncommitted changes: commit them to qa (or stash) first." >&2; exit 1; }
fi

case "$cmd" in
  install)
    # staging's own database password, created once (never printed)
    if ! aws ssm get-parameter --region "$REGION" --name "$PARAM" >/dev/null 2>&1; then
      pw="$(python3 -c 'import secrets,string; print("".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32)))')"
      umask 077; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
      printf '{"Value":"postgresql://%s:%s@127.0.0.1:5432/%s"}' "$OPS_DB" "$pw" "$OPS_DB" > "$tmp"
      aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString --cli-input-json "file://$tmp" >/dev/null
      echo "→ created $PARAM"
    fi
    SKIP_DB_BACKUP=1 exec ./deploy.sh ops-console install ;;
  expose)
    exec ./deploy.sh ops-console expose "$DOMAIN" ;;
  set-admin|platform-admin)
    user="${2:?usage: deploy-staging.sh $1 <username>}"
    [[ "$user" =~ ^[A-Za-z0-9._-]{3,32}$ ]] || { echo "bad username" >&2; exit 1; }
    if [[ "$1" == set-admin ]]; then read -rsp "Password for $user on staging: " pw; echo; cli="set-admin $user"
    else onoff="${3:?usage: deploy-staging.sh platform-admin <username> on|off}"; [[ "$onoff" == on || "$onoff" == off ]] || { echo "on or off" >&2; exit 1; }; pw=""; cli="platform-admin $user $onoff"; fi
    TARGET="${DEPLOY_USER:-ec2-user}@${DEPLOY_HOST:?set DEPLOY_HOST}"
    if [[ -n "${EC2_INSTANCE_ID:-}" ]]; then
      key="$(mktemp -d)/key"; ssh-keygen -q -t ed25519 -N '' -f "$key"
      aws ec2-instance-connect send-ssh-public-key --region "$REGION" --instance-id "$EC2_INSTANCE_ID" --instance-os-user "${DEPLOY_USER:-ec2-user}" --ssh-public-key "file://$key.pub" >/dev/null
    else key="${DEPLOY_SSH_KEY:?set DEPLOY_SSH_KEY or EC2_INSTANCE_ID}"; fi
    printf '%s' "$pw" | ssh -o BatchMode=yes -i "$key" "$TARGET" \
      "sudo bash -c 'set -a; . /run/app-secrets/$INSTANCE.env; set +a; cd /opt/$INSTANCE/api && exec node dist/cli.js $cli'"
    if [[ "$1" == set-admin ]]; then echo "Next: sign in at https://$DOMAIN and create a workspace; for the platform portal: $0 platform-admin $user on"; fi ;;
  *) sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
