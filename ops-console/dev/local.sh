#!/usr/bin/env bash
# =============================================================================
# Run the Ops Console on this laptop to test a branch before it is deployed.
#
#   ops-console/dev/local.sh            build once, serve on http://localhost:9300
#   ops-console/dev/local.sh --watch    rebuild on every change: http://localhost:5173 (hot reload)
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
ROOT="$PWD"; STATE="$ROOT/.local"; mkdir -p "$STATE"
API_PORT="${OPS_LOCAL_PORT:-9300}"
WATCH=0; [[ "${1:-}" == --watch ]] && WATCH=1
aws sts get-caller-identity >/dev/null 2>&1 || { echo "✘ AWS CLI has no working credentials (needed for live data)"; exit 1; }
for port in "${OPS_LOCAL_PG_PORT:-55432}" "$API_PORT" 5173; do
  if ss -ltn 2>/dev/null | grep -q ":$port "; then echo "✘ port $port is already in use (another local.sh still running?)"; exit 1; fi
done

echo "→ installing dependencies (first run only)"
[[ -d api/node_modules ]] || (cd api && npm ci --no-audit --no-fund >/dev/null)
[[ -d web/node_modules ]] || (cd web && npm ci --no-audit --no-fund >/dev/null)
echo "→ building API"; (cd api && npx tsc -p .)

pids=()
cleanup() {
  trap - EXIT INT TERM
  for p in "${pids[@]}"; do kill -INT "$p" 2>/dev/null || true; done           # bootstrap stops PostgreSQL on SIGINT
  sleep 2
  pkill -TERM -P $$ 2>/dev/null || true                                         # anything still parented here
  for p in "${pids[@]}"; do pkill -TERM -P "$p" 2>/dev/null || true; done      # npx children (tsc, vite)
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

node dev/bootstrap.cjs > "$STATE/bootstrap.log" 2>&1 & pids+=($!)
for _ in $(seq 1 90); do grep -q READY "$STATE/bootstrap.log" 2>/dev/null && break; sleep 1; kill -0 "${pids[0]}" 2>/dev/null || { cat "$STATE/bootstrap.log"; exit 1; }; done
grep -v READY "$STATE/bootstrap.log" | sed 's/^/  /'

export DATABASE_URL="postgresql://postgres:local@127.0.0.1:${OPS_LOCAL_PG_PORT:-55432}/opsconsole"
export PORT="$API_PORT" HOST=127.0.0.1 COOKIE_SECURE=false TRUST_PROXY=false WEB_DIST=../web/dist
export ALLOWED_ORIGINS="http://localhost:$API_PORT,http://localhost:5173" PUBLIC_URL="http://localhost:$API_PORT"
export OPS_DRY_RUN="${OPS_DRY_RUN:-1}" ALERTS_DRY_RUN="${ALERTS_DRY_RUN:-1}" AWS_REGION="${AWS_REGION:-af-south-1}"
export TRANSFER_BUCKET="${TRANSFER_BUCKET:-$(aws ssm get-parameter --region "$AWS_REGION" --name /apps/ops-console/TRANSFER_BUCKET --query Parameter.Value --output text 2>/dev/null || true)}"

if [[ $WATCH == 1 ]]; then
  (cd api && npx tsc -p . --watch --preserveWatchOutput > "$STATE/tsc.log" 2>&1) & pids+=($!)
  (cd api && node --watch-path=dist dist/server.js) & pids+=($!)
  (cd web && OPS_API_PORT="$API_PORT" npx vite --host 127.0.0.1 --port 5173 --strictPort) & pids+=($!)
  URL="http://localhost:5173"
else
  echo "→ building web"; (cd web && npx vite build --logLevel warn)
  (cd api && node dist/server.js) & pids+=($!)
  URL="http://localhost:$API_PORT"
fi
sleep 3
cat <<MSG

  ✔ Ops Console (local test mode) → $URL
    logins: $STATE/credentials.txt   (admin / deployer / viewer, or "Try the read-only demo")
    deploys and "Back up now" are simulated; notifications are printed below. Ctrl-C to stop.

MSG
wait -n "${pids[@]}"
