#!/usr/bin/env bash
# =============================================================================
# Run the Ops Console on this laptop to test a branch before it is deployed.
#
#   ops-console/dev/local.sh            build once, serve on http://localhost:9300
#   ops-console/dev/local.sh --watch    rebuild on every change: http://localhost:5173 (hot reload)
#   ops-console/dev/local.sh --password admin   choose a local login's password (server must be running)
#   ops-console/dev/local.sh --saas [--watch]   the multi-customer product instead: landing page, sign-up, workspaces
#        (its own database in ops-console/.local-saas, ports 5174 / 9301, connects as a non-superuser so
#        row-level security applies; AWS is refused for workspaces, as in production until Phase 12b)
#
# - Live data: talks to the real instance through SSM with your AWS CLI credentials.
# - Local database (ops-console/.local, git-ignored) with test logins; see ops-console/.local/credentials.txt
# - SAFE: deploys/rollbacks and "Back up now" are simulated (OPS_DRY_RUN=1); alert emails/webhooks are only
#   printed here (ALERTS_DRY_RUN=1). Restore tests and downloads are real: they never touch live data.
#   Set OPS_DRY_RUN=0 to do real deploys from your laptop.
# Ctrl-C stops everything. Delete ops-console/.local to start over.
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")/.."
WATCH=0; SAAS=0
for a in "$@"; do case "$a" in --watch) WATCH=1 ;; --saas) SAAS=1 ;; esac; done
ROOT="$PWD"
if [[ $SAAS == 1 ]]; then
  STATE="$ROOT/.local-saas"; API_PORT="${OPS_LOCAL_PORT:-9301}"; WEB_PORT=5174; export OPS_LOCAL_PG_PORT="${OPS_LOCAL_PG_PORT:-55433}" OPS_LOCAL_SAAS=1
else
  STATE="$ROOT/.local"; API_PORT="${OPS_LOCAL_PORT:-9300}"; WEB_PORT=5173
fi
export OPS_LOCAL_STATE="$STATE"; mkdir -p "$STATE"
if [[ "${1:-}" == --password ]]; then   # local.sh --password <user>: choose a local test login's password
  u="${2:?usage: local.sh --password <admin|deployer|viewer>}"
  read -r -s -p "New local password for $u: " p1; echo; read -r -s -p "Repeat: " p2; echo
  [[ "$p1" == "$p2" ]] || { echo "✘ passwords differ"; exit 1; }
  printf '%s' "$p1" | node dev/set-password.cjs "$u"; exit $?
fi
aws sts get-caller-identity >/dev/null 2>&1 || { echo "✘ AWS CLI has no working credentials (needed for live data)"; exit 1; }
for port in "${OPS_LOCAL_PG_PORT:-55432}" "$API_PORT" "$WEB_PORT"; do
  if ss -ltn 2>/dev/null | grep -q ":$port "; then echo "✘ port $port is already in use (another local.sh still running?)"; exit 1; fi
done

echo "→ installing dependencies (first run only)"
[[ -d api/node_modules ]] || (cd api && npm ci --no-audit --no-fund >/dev/null)
[[ -d web/node_modules ]] || (cd web && npm ci --no-audit --no-fund >/dev/null)
echo "→ building API"; (cd api && npx tsc -p .)

pids=()
BOOT=""
cleanup() {
  trap - EXIT INT TERM
  for p in "${pids[@]}"; do kill -TERM "$p" 2>/dev/null || true; done           # tsc, vite, API (each is the real node process)
  [[ -n "$BOOT" ]] && kill -INT "$BOOT" 2>/dev/null || true                      # bootstrap stops PostgreSQL cleanly on SIGINT
  wait 2>/dev/null || true
  echo "stopped"
}
trap cleanup EXIT INT TERM

node dev/bootstrap.cjs > "$STATE/bootstrap.log" 2>&1 & BOOT=$!
for _ in $(seq 1 90); do grep -q READY "$STATE/bootstrap.log" 2>/dev/null && break; sleep 1; kill -0 "$BOOT" 2>/dev/null || { cat "$STATE/bootstrap.log"; exit 1; }; done
grep -v READY "$STATE/bootstrap.log" | sed 's/^/  /' || true   # nothing else to show (e.g. a second --saas start) is fine

if [[ $SAAS == 1 ]]; then
  export DATABASE_URL="postgresql://opsconsole_app:local@127.0.0.1:${OPS_LOCAL_PG_PORT}/opsconsole_saas" OPS_MULTI_TENANT=1 PRODUCT_NAME="${PRODUCT_NAME:-Ops Console}"
  # billing: Paystack TEST key only (never a live key on a laptop); default: LiftParcel's test key from SSM
  if [[ -z "${PAYSTACK_SECRET_KEY:-}" ]]; then
    k="$(aws ssm get-parameter --region "${AWS_REGION:-af-south-1}" --name /apps/liftparcel/PAYSTACK_SECRET_KEY --with-decryption --query Parameter.Value --output text 2>/dev/null || true)"
    [[ "$k" == sk_test_* ]] && export PAYSTACK_SECRET_KEY="$k"; unset k
  fi
  [[ -z "${PAYSTACK_SECRET_KEY:-}" || "$PAYSTACK_SECRET_KEY" == sk_test_* ]] || { echo "✘ PAYSTACK_SECRET_KEY must be a TEST key (sk_test_…) locally"; exit 1; }
else
  export DATABASE_URL="postgresql://postgres:local@127.0.0.1:${OPS_LOCAL_PG_PORT:-55432}/opsconsole"
fi
export PORT="$API_PORT" HOST=127.0.0.1 COOKIE_SECURE=false TRUST_PROXY=false WEB_DIST=../web/dist
export ALLOWED_ORIGINS="http://localhost:$API_PORT,http://localhost:$WEB_PORT" PUBLIC_URL="http://localhost:$([[ $WATCH == 1 ]] && echo $WEB_PORT || echo $API_PORT)"
export OPS_DRY_RUN="${OPS_DRY_RUN:-1}" ALERTS_DRY_RUN="${ALERTS_DRY_RUN:-1}" AWS_REGION="${AWS_REGION:-af-south-1}"
export OPS_ALLOW_LOOPBACK_ORIGINS=1   # localhost, 127.0.0.1 or [::1], any port
export TRANSFER_BUCKET="${TRANSFER_BUCKET:-$(aws ssm get-parameter --region "$AWS_REGION" --name /apps/ops-console/TRANSFER_BUCKET --query Parameter.Value --output text 2>/dev/null || true)}"

if [[ $WATCH == 1 ]]; then
  # exec the real node processes (not npx wrappers) so the recorded PIDs are what we stop on exit
  (cd api && exec node node_modules/typescript/bin/tsc -p . --watch --preserveWatchOutput > "$STATE/tsc.log" 2>&1) & pids+=($!)
  (cd api && exec node --watch-path=dist dist/server.js) & pids+=($!)
  (cd web && OPS_API_PORT="$API_PORT" exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$WEB_PORT" --strictPort) & pids+=($!)
  URL="http://localhost:$WEB_PORT"
else
  echo "→ building web"; (cd web && npx vite build --logLevel warn)
  (cd api && exec node dist/server.js) & pids+=($!)
  URL="http://localhost:$API_PORT"
fi
sleep 3
cat <<MSG

  ✔ Ops Console (local test mode$([[ $SAAS == 1 ]] && echo ', multi-customer')) → $URL
    $([[ $SAAS == 1 ]] && echo 'sign up on the landing page; emails (verification, invites, resets) are printed below' || echo "logins: $STATE/credentials.txt   (admin / deployer / viewer, or \"Try the read-only demo\")")
    deploys and "Back up now" are simulated; notifications are printed below. Ctrl-C to stop.

MSG
wait -n "${pids[@]}" "$BOOT"
