#!/usr/bin/env bash
# =============================================================================
# install-ops-console.sh: runs ON the server (as ec2-user with sudo). Idempotent.
#   install-ops-console.sh install          build + DB + service (+ demo account)
#   install-ops-console.sh expose <domain>  serve it publicly over HTTPS (replaces the old ops-dashboard vhost)
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
  # the console's own database is in the nightly backups (and their off-site copies) like the apps' databases
  { sudo cat /opt/deploy-state/backup-extra-dbs 2>/dev/null; echo opsconsole; } | grep -E '^[a-z0-9_]{1,40}$' | sort -u | sudo tee /opt/deploy-state/backup-extra-dbs.tmp >/dev/null
  sudo install -m 0644 -o ec2-user -g ec2-user /opt/deploy-state/backup-extra-dbs.tmp /opt/deploy-state/backup-extra-dbs && sudo rm -f /opt/deploy-state/backup-extra-dbs.tmp
  ok "console database in the nightly backups"

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

expose() {
  local domain="${1:?usage: expose <domain>}"
  [[ "$domain" =~ ^[a-z0-9.-]+$ ]] || die "bad domain"
  local me resolved
  me="$(curl -fsS -m 3 https://checkip.amazonaws.com)"
  resolved="$(getent hosts "$domain" | awk '{print $1}' | head -1 || true)"
  [[ "$resolved" == "$me" ]] || die "$domain resolves to '${resolved:-nothing}', not this host. Add the DNS A record first."
  curl -fsS -m 3 http://127.0.0.1:9200/api/health >/dev/null || die "the console isn't running; run 'install' first"

  log "nginx vhost → 127.0.0.1:9200"
  local retired=/etc/nginx/retired; sudo install -d -m 0755 "$retired"
  local old; old="$(sudo grep -l "server_name $domain;" /etc/nginx/conf.d/*.conf 2>/dev/null | grep -v '/ops-console.conf$' || true)"
  for f in $old; do sudo mv "$f" "$retired/$(basename "$f").$(date +%Y%m%d%H%M%S)"; log "retired $f → $retired/"; done
  sed "s/__OPS_DOMAIN__/$domain/" "$ROOT/templates/nginx-ops-console.conf" | sudo tee /etc/nginx/conf.d/ops-console.conf >/dev/null
  if ! sudo nginx -t 2>/dev/null; then
    sudo nginx -t || true
    sudo rm -f /etc/nginx/conf.d/ops-console.conf
    for f in $old; do sudo cp "$(ls -1t "$retired/$(basename "$f")".* | head -1)" "$f"; done
    die "nginx config test failed; previous vhost restored"
  fi
  sudo systemctl reload nginx

  log "TLS certificate (reuses the existing one if present)"
  sudo certbot --nginx -d "$domain" --non-interactive --agree-tos --redirect --reinstall --register-unsafely-without-email \
    || sudo certbot --nginx -d "$domain" --non-interactive --redirect --reinstall
  sudo nginx -t && sudo systemctl reload nginx
  ok "https://$domain → Ops Console (sign in, or 'Try the read-only demo')"
}

case "${1:-}" in
  install) install ;;
  expose)  shift; expose "$@" ;;
  *) echo "usage: install-ops-console.sh install | expose <domain>" >&2; exit 1 ;;
esac
