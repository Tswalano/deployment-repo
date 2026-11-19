#!/usr/bin/env bash
# =============================================================================
# install-ops-console.sh: runs ON the server (as ec2-user with sudo). Idempotent.
#   install-ops-console.sh install          build + DB + service (+ demo account)
#   install-ops-console.sh expose <domain>  serve it publicly over HTTPS (replaces the old ops-dashboard vhost)
#
# Needs SSM /apps/<instance>/DATABASE_URL (postgresql://<db>:<pw>@127.0.0.1:5432/<db>),
# created by scripts/setup-ops-console.sh on your laptop.
#
# A second, separate copy (e.g. staging) runs side by side with its own service, port, database, settings and vhost:
#   INSTANCE=ops-console-staging OPS_PORT=9210 OPS_DB=opsconsole_staging OPS_ORIGIN=https://staging.glenify.studio
# (scripts/deploy-staging.sh sets these). The defaults are the production console, unchanged.
# =============================================================================
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${INSTANCE:-ops-console}"
PORT="${OPS_PORT:-9200}"
DB="${OPS_DB:-opsconsole}"
ORIGIN="${OPS_ORIGIN:-https://ops.glenify.studio}"
[[ "$NAME" =~ ^ops-console(-[a-z0-9]+)?$ && "$PORT" =~ ^[0-9]{4,5}$ && "$DB" =~ ^opsconsole(_[a-z0-9]+)?$ && "$ORIGIN" =~ ^https://[a-z0-9.-]+$ ]] \
  || { echo "bad INSTANCE / OPS_PORT / OPS_DB / OPS_ORIGIN" >&2; exit 1; }
APP="/opt/$NAME"
ZONE="${DB}_auth"                     # nginx rate-limit zone: one per copy (opsconsole_auth for production, as before)
REGION="${AWS_REGION:-af-south-1}"
log() { printf '\e[36m[%s] %s\e[0m\n' "$NAME" "$*"; }
ok()  { printf '\e[32m[%s] ✔ %s\e[0m\n' "$NAME" "$*"; }
die() { printf '\e[31m[%s] ✘ %s\e[0m\n' "$NAME" "$*" >&2; exit 1; }
# the service unit for this copy: the production unit with its name, port, folder and origin swapped (identical for production)
unit() { sed -e "s#/opt/ops-console#$APP#g" -e "s#app-secrets@ops-console#app-secrets@$NAME#g" -e "s#/run/app-secrets/ops-console.env#/run/app-secrets/$NAME.env#g" \
             -e "s#/apps/ops-console/#/apps/$NAME/#g" -e "s#PORT=9200#PORT=$PORT#" -e "s#localhost:9200#localhost:$PORT#" \
             -e "s#https://ops.glenify.studio#$ORIGIN#" "$ROOT/systemd/ops-console.service"; }
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

  log "database $DB (own role, nobody else may connect)"
  local url pw
  url="$(aws ssm get-parameter --region "$REGION" --name "/apps/$NAME/DATABASE_URL" --with-decryption --query Parameter.Value --output text)" \
    || die "missing SSM /apps/$NAME/DATABASE_URL (run scripts/setup-ops-console.sh)"
  pw="$(python3 -I -c 'import sys,urllib.parse as u; print(u.unquote(u.urlsplit(sys.argv[1]).password or ""))' "$url")"
  [[ "$pw" =~ ^[A-Za-z0-9]{24,}$ ]] || die "DATABASE_URL password must be 24+ alphanumerics"
  psql -X -q -h localhost -U postgres -w -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB') THEN CREATE ROLE $DB LOGIN; END IF;
END \$\$;
ALTER ROLE $DB WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$pw' CONNECTION LIMIT 10;
SQL
  if ! psql -X -tA -h localhost -U postgres -w -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
    psql -X -q -h localhost -U postgres -w -d postgres -c "CREATE DATABASE $DB OWNER $DB"
  fi
  psql -X -q -h localhost -U postgres -w -d postgres -c "REVOKE CONNECT ON DATABASE $DB FROM PUBLIC" -c "GRANT CONNECT ON DATABASE $DB TO $DB"
  ok "database ready"
  # the console's own database is in the nightly backups (and their off-site copies) like the apps' databases
  { sudo cat /opt/deploy-state/backup-extra-dbs 2>/dev/null || true; echo "$DB"; } | grep -E '^[a-z0-9_]{1,40}$' | sort -u | sudo tee /opt/deploy-state/backup-extra-dbs.tmp >/dev/null
  sudo install -m 0644 -o ec2-user -g ec2-user /opt/deploy-state/backup-extra-dbs.tmp /opt/deploy-state/backup-extra-dbs && sudo rm -f /opt/deploy-state/backup-extra-dbs.tmp
  ok "console database in the nightly backups"

  log "service"
  sudo install -m 0755 -o root -g root "$ROOT/server/load-app-secrets.sh" /usr/local/bin/load-app-secrets
  sudo install -m 0644 "$ROOT/systemd/app-secrets@.service" /etc/systemd/system/app-secrets@.service
  unit | sudo tee "/etc/systemd/system/$NAME.service" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet "$NAME"
  sudo systemctl restart "$NAME"        # runs migrations on start
  for _ in $(seq 1 30); do curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null || { sudo journalctl -u "$NAME" -n 30 --no-pager; die "not healthy"; }
  ok "running on 127.0.0.1:$PORT ($(( $(systemctl show "$NAME" -p MemoryCurrent --value) / 1048576 )) MB)"

  log "demo account"
  sudo bash -c "set -a; . /run/app-secrets/$NAME.env; set +a; cd $APP/api && exec node dist/cli.js ensure-demo"
}

expose() {
  local domain="${1:?usage: expose <domain>}"
  [[ "$domain" =~ ^[a-z0-9.-]+$ ]] || die "bad domain"
  local me resolved
  me="$(curl -fsS -m 3 https://checkip.amazonaws.com)"
  resolved="$(getent hosts "$domain" | awk '{print $1}' | head -1 || true)"
  [[ "$resolved" == "$me" ]] || die "$domain resolves to '${resolved:-nothing}', not this host. Add the DNS A record first."
  curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null || die "the console isn't running; run 'install' first"

  log "nginx vhost → 127.0.0.1:$PORT"
  local retired=/etc/nginx/retired; sudo install -d -m 0755 "$retired"
  local old; old="$(sudo grep -l "server_name $domain;" /etc/nginx/conf.d/*.conf 2>/dev/null | grep -v "/$NAME.conf\$" || true)"
  for f in $old; do sudo mv "$f" "$retired/$(basename "$f").$(date +%Y%m%d%H%M%S)"; log "retired $f → $retired/"; done
  sed -e "s/__OPS_DOMAIN__/$domain/" -e "s#127.0.0.1:9200#127.0.0.1:$PORT#g" -e "s/opsconsole_auth/$ZONE/g" "$ROOT/templates/nginx-ops-console.conf" \
    | sudo tee "/etc/nginx/conf.d/$NAME.conf" >/dev/null
  if ! sudo nginx -t 2>/dev/null; then
    sudo nginx -t || true
    sudo rm -f "/etc/nginx/conf.d/$NAME.conf"
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
