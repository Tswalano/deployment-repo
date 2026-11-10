#!/usr/bin/env bash
# =============================================================================
# install-ops-dashboard.sh — runs ON the server (as ec2-user with sudo). Idempotent.
#
#   install-ops-dashboard.sh install          # service on 127.0.0.1:9100 (no public exposure)
#   install-ops-dashboard.sh expose <domain>  # nginx vhost + basic auth + Let's Encrypt cert
#
# Needs in SSM Parameter Store (create from your laptop, see README → Ops dashboard):
#   /apps/ops-dashboard/PGPASSWORD          password for the read-only `ops_monitor` Postgres role
#   /apps/ops-dashboard-auth/PASSWORD       basic-auth password for the web UI (expose only)
# =============================================================================
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:-af-south-1}"
log() { printf '\e[36m[ops-dashboard] %s\e[0m\n' "$*"; }
ok()  { printf '\e[32m[ops-dashboard] ✔ %s\e[0m\n' "$*"; }
die() { printf '\e[31m[ops-dashboard] ✘ %s\e[0m\n' "$*" >&2; exit 1; }

ssm_get() { aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption --query Parameter.Value --output text; }

install() {
  log "system user"
  id opsdash >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /sbin/nologin opsdash
  ok "user opsdash"

  log "read-only Postgres role ops_monitor (pg_monitor)"
  local pw; pw="$(ssm_get /apps/ops-dashboard/PGPASSWORD)" || die "missing SSM /apps/ops-dashboard/PGPASSWORD"
  [[ "$pw" =~ ^[A-Za-z0-9_-]{24,}$ ]] || die "PGPASSWORD must be 24+ chars of [A-Za-z0-9_-]"
  # SQL goes over stdin so the password never appears in a process list
  (cd /tmp && psql -X -q -h localhost -U postgres -w -d postgres -v ON_ERROR_STOP=1) <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_monitor') THEN
    CREATE ROLE ops_monitor LOGIN;
  END IF;
END \$\$;
ALTER ROLE ops_monitor WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$pw' CONNECTION LIMIT 5;
GRANT pg_monitor TO ops_monitor;
SQL
  ok "role ops_monitor (pg_monitor, max 5 connections)"

  log "service"
  sudo install -m 0755 -o root -g root "$ROOT/server/load-app-secrets.sh" /usr/local/bin/load-app-secrets
  sudo install -m 0644 "$ROOT/systemd/ops-dashboard.service" /etc/systemd/system/ops-dashboard.service
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet ops-dashboard
  sudo systemctl restart ops-dashboard
  for _ in $(seq 1 20); do curl -fsS -m 2 http://127.0.0.1:9100/healthz >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS -m 2 http://127.0.0.1:9100/healthz >/dev/null || { sudo journalctl -u ops-dashboard -n 20 --no-pager; die "not responding"; }
  local db; db="$(curl -fsS -m 20 http://127.0.0.1:9100/api/status | python3 -c 'import sys,json;d=json.load(sys.stdin);print("db ok" if d["database"]["ok"] else "db ERROR: "+d["database"]["error"], "| projects:", ",".join(p["project"] for p in d["projects"]), "| collect", d["collect_ms"], "ms")')"
  ok "running on 127.0.0.1:9100 — $db"
  echo "View it now via a tunnel:  ssh -L 9100:127.0.0.1:9100 ec2-user@<host>   → http://localhost:9100"
}

expose() {
  local domain="${1:?usage: expose <domain>}"
  [[ "$domain" =~ ^[a-z0-9.-]+$ ]] || die "bad domain"
  local me resolved
  me="$(curl -fsS -m 3 https://checkip.amazonaws.com)"
  resolved="$(getent hosts "$domain" | awk '{print $1}' | head -1 || true)"
  [[ "$resolved" == "$me" ]] || die "$domain resolves to '${resolved:-nothing}', not this host ($me). Add the DNS A record first."

  log "basic auth"
  local pw; pw="$(ssm_get /apps/ops-dashboard-auth/PASSWORD)" || die "missing SSM /apps/ops-dashboard-auth/PASSWORD"
  printf 'ops:%s\n' "$(printf '%s' "$pw" | openssl passwd -apr1 -stdin)" | sudo tee /etc/nginx/ops-dashboard.htpasswd >/dev/null
  sudo chown root:nginx /etc/nginx/ops-dashboard.htpasswd && sudo chmod 640 /etc/nginx/ops-dashboard.htpasswd
  ok "user 'ops' (password from SSM)"

  log "nginx vhost"
  sed "s/__OPS_DOMAIN__/$domain/" "$ROOT/templates/nginx-ops-dashboard.conf" | sudo tee /etc/nginx/conf.d/ops-dashboard.conf >/dev/null
  sudo nginx -t && sudo systemctl reload nginx

  log "TLS certificate"
  sudo certbot --nginx -d "$domain" --non-interactive --agree-tos --redirect --register-unsafely-without-email \
    || sudo certbot --nginx -d "$domain" --non-interactive --redirect
  ok "https://$domain (user: ops)"
}

case "${1:-}" in
  install) install ;;
  expose)  shift; expose "$@" ;;
  *) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
