#!/usr/bin/env bash
# =============================================================================
# install-ops-console.sh: runs ON the server (as ec2-user with sudo). Idempotent.
#   install-ops-console.sh install     build + DB + service (+ demo account)
#
# Needs SSM /apps/ops-console/DATABASE_URL (postgresql://opsconsole:<pw>@127.0.0.1:5432/opsconsole),
# created by scripts/setup-ops-console.sh on your laptop.
# =============================================================================
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/ops-console
REGION="${AWS_REGION:-af-south-1}"
log() { printf '\e[36m[ops-console] %s\e[0m\n' "$*"; }
ok()  { printf '\e[32m[ops-console] ✔ %s\e[0m\n' "$*"; }
die() { printf '\e[31m[ops-console] ✘ %s\e[0m\n' "$*" >&2; exit 1; }
cd /tmp

install() {
  log "system user"
  id opsconsole >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /sbin/nologin opsconsole
  ok "user opsconsole"

  log "code → $APP"
  sudo install -d -m 0755 -o ec2-user -g ec2-user "$APP"
  rsync -a --delete --exclude node_modules --exclude dist "$ROOT/ops-console/" "$APP/"

  log "build API (prod deps only afterwards)"
  (cd "$APP/api" && npm ci --no-audit --no-fund --omit=optional >/dev/null && npm run build >/dev/null && npm prune --omit=dev >/dev/null)
  ok "api built"
  log "build web"
  (cd "$APP/web" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null && rm -rf node_modules)
  ok "web built ($(du -sh "$APP/web/dist" | cut -f1))"

  log "database opsconsole (own role, nobody else may connect)"
  local url pw
  url="$(aws ssm get-parameter --region "$REGION" --name /apps/ops-console/DATABASE_URL --with-decryption --query Parameter.Value --output text)" \
    || die "missing SSM /apps/ops-console/DATABASE_URL (run scripts/setup-ops-console.sh)"
  pw="$(python3 -I -c 'import sys,urllib.parse as u; print(u.unquote(u.urlsplit(sys.argv[1]).password or ""))' "$url")"
  [[ "$pw" =~ ^[A-Za-z0-9]{24,}$ ]] || die "DATABASE_URL password must be 24+ alphanumerics"
  psql -X -q -h localhost -U postgres -w -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opsconsole') THEN CREATE ROLE opsconsole LOGIN; END IF;
END \$\$;
ALTER ROLE opsconsole WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$pw' CONNECTION LIMIT 10;
SQL
  if ! psql -X -tA -h localhost -U postgres -w -d postgres -c "SELECT 1 FROM pg_database WHERE datname='opsconsole'" | grep -q 1; then
    psql -X -q -h localhost -U postgres -w -d postgres -c "CREATE DATABASE opsconsole OWNER opsconsole"
  fi
  psql -X -q -h localhost -U postgres -w -d postgres -c "REVOKE CONNECT ON DATABASE opsconsole FROM PUBLIC" -c "GRANT CONNECT ON DATABASE opsconsole TO opsconsole"
  ok "database ready"

  log "service"
  sudo install -m 0755 -o root -g root "$ROOT/server/load-app-secrets.sh" /usr/local/bin/load-app-secrets
  sudo install -m 0644 "$ROOT/systemd/app-secrets@.service" /etc/systemd/system/app-secrets@.service
  sudo install -m 0644 "$ROOT/systemd/ops-console.service" /etc/systemd/system/ops-console.service
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet ops-console
  sudo systemctl restart ops-console        # runs migrations on start
  for _ in $(seq 1 30); do curl -fsS -m 2 http://127.0.0.1:9200/api/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS -m 2 http://127.0.0.1:9200/api/health >/dev/null || { sudo journalctl -u ops-console -n 30 --no-pager; die "not healthy"; }
  ok "running on 127.0.0.1:9200 ($(( $(systemctl show ops-console -p MemoryCurrent --value) / 1048576 )) MB)"

  log "demo account"
  sudo bash -c 'set -a; . /run/app-secrets/ops-console.env; set +a; cd /opt/ops-console/api && exec node dist/cli.js ensure-demo'
}

case "${1:-}" in
  install) install ;;
  *) echo "usage: install-ops-console.sh install" >&2; exit 1 ;;
esac
