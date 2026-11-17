#!/bin/bash
# OpsConsole-PrepareServer: turn a fresh Amazon Linux 2023 EC2 instance into one the console can run apps on.
# Safe to run again (every step checks first). Installs:
#   nginx, git, certbot, Node.js (newest of 22/20/18 available), PostgreSQL 15 (password auth on localhost, a
#   generated postgres password in ~/.pgpass for ec2-user and root), a swap file on small instances,
#   the console's server files from a release bundle (pipeline, settings loader, status agent, backups) into
#   /opt/deploy, the read-only status agent (127.0.0.1:9100) and the nightly database backup timer.
# Parameters: bundleUrl (our public release bundle) + sha256 (checked before anything is unpacked).
# The status agent's database password is read from SSM /apps/ops-dashboard/PGPASSWORD (the console puts it there).
# Output: progress lines, then one JSON line {"ok":…,"step":…,"error":…,"node":…,"steps":[…]}.
set -u
export LC_ALL=C
BUNDLE_URL='{{ bundleUrl }}'
BUNDLE_SHA='{{ sha256 }}'
[[ "$BUNDLE_URL" =~ ^https://ops-console-public-[0-9]{12}-[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com/bundles/[0-9a-f]{64}\.tar\.gz$ ]] || { echo '{"ok":false,"step":"input","error":"invalid bundle URL"}'; exit 2; }
[[ "$BUNDLE_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo '{"ok":false,"step":"input","error":"invalid checksum"}'; exit 2; }

STEP=start; DONE=(); NODEV=""
log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
emit() { python3 -I -c 'import json,sys; ok=sys.argv[1]=="1"; print(json.dumps({"ok":ok,"step":sys.argv[2],"error":sys.argv[3] or None,"node":sys.argv[4] or None,"steps":[s for s in sys.argv[5:] if s]}))' "$@"; }
fail() { log "✘ $*"; emit 0 "$STEP" "$*" "$NODEV" "${DONE[@]}"; exit 1; }
did()  { DONE+=("$1"); log "✔ $1"; }

# ------------------------------------------------------------------ checks
STEP=check
. /etc/os-release 2>/dev/null || true
[[ "${ID:-}" == amzn && "${VERSION_ID:-}" == 2023* ]] || fail "only Amazon Linux 2023 is supported for now (this is ${PRETTY_NAME:-unknown})"
REGION="$(TOKEN=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60') && curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)" || fail "could not read the instance region"
FREE_GB=$(( $(df --output=avail -k / | tail -1) / 1048576 ))
(( FREE_GB >= 2 )) || fail "only ${FREE_GB} GB free on / (need at least 2 GB)"
MEM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
log "Amazon Linux 2023 in $REGION, ${MEM_MB} MB memory, ${FREE_GB} GB free"

# ------------------------------------------------------------------ packages
STEP=packages
NODEPKG=""
for v in 22 20 18; do dnf -q list --available "nodejs$v" >/dev/null 2>&1 && { NODEPKG="nodejs$v nodejs$v-npm"; break; }; done
[[ -n "$NODEPKG" ]] || NODEPKG="nodejs npm"
dnf -y -q install nginx git certbot python3-certbot-nginx postgresql15-server postgresql15 $NODEPKG >/tmp/opsprep-dnf.log 2>&1 || { tail -5 /tmp/opsprep-dnf.log; fail "package install failed"; }
# versioned Node packages install /usr/bin/node-NN: make sure plain `node` / `npm` exist
if ! command -v node >/dev/null; then
  n="$(ls -1 /usr/bin/node-[0-9]* 2>/dev/null | sort -V | tail -1)"; [[ -n "$n" ]] && ln -sf "$n" /usr/local/bin/node
  m="$(ls -1 /usr/bin/npm-[0-9]* 2>/dev/null | sort -V | tail -1)"; [[ -n "$m" ]] && ln -sf "$m" /usr/local/bin/npm
fi
NODEV="$(node -v 2>/dev/null)" || fail "node is not on the PATH after installing $NODEPKG"
did "packages (nginx, git, certbot, PostgreSQL 15, Node.js $NODEV)"

STEP=swap
if (( MEM_MB < 2048 )) && ! swapon --show | grep -q .; then
  if fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap defaults 0 0' >> /etc/fstab
    did "1 GB swap file (small instance: keeps npm builds from running out of memory)"
  else
    rm -f /swapfile; log "⚠ could not add a swap file; continuing without one"
  fi
fi

# ------------------------------------------------------------------ PostgreSQL
STEP=postgres
PGDATA=/var/lib/pgsql/data
if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  postgresql-setup --initdb >/dev/null 2>&1 || fail "postgresql initdb failed"
fi
systemctl enable --quiet --now postgresql || fail "postgresql did not start"
if [[ ! -s /root/.pgpass ]] || ! grep -q '^localhost:5432:\*:postgres:' /root/.pgpass; then
  PGPW="$(python3 -I -c 'import secrets; print(secrets.token_urlsafe(24))')"
  sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -c "ALTER ROLE postgres WITH PASSWORD '$PGPW'" >/dev/null || fail "could not set the postgres password"
  for h in /root /home/ec2-user; do
    printf 'localhost:5432:*:postgres:%s\n127.0.0.1:5432:*:postgres:%s\n' "$PGPW" "$PGPW" > "$h/.pgpass"
    chmod 600 "$h/.pgpass"; chown "$(stat -c %U "$h")":"$(stat -c %G "$h")" "$h/.pgpass"
  done
  unset PGPW
fi
# password (md5) for TCP and local socket logins; keep peer for replication as shipped
if grep -qE '^(local|host)\s+all\s+all\s+.*(ident|peer)\s*$' "$PGDATA/pg_hba.conf"; then
  cp -p "$PGDATA/pg_hba.conf" "$PGDATA/pg_hba.conf.ops-console.bak"
  sed -i -E 's/^((local|host)\s+all\s+all\s+.*)(ident|peer)\s*$/\1md5/' "$PGDATA/pg_hba.conf"
  systemctl reload postgresql
fi
psql -X -q -h localhost -U postgres -w -d postgres -c 'SELECT 1' >/dev/null || fail "cannot log in to PostgreSQL with the generated password"
did "PostgreSQL 15 (password logins on localhost)"

# ------------------------------------------------------------------ the console's server files
STEP=bundle
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsS -m 120 -o "$TMP/bundle.tgz" "$BUNDLE_URL" || fail "could not download the release bundle"
echo "$BUNDLE_SHA  $TMP/bundle.tgz" | sha256sum -c --status || fail "the release bundle's checksum does not match"
mkdir -p "$TMP/x" && tar -xzf "$TMP/bundle.tgz" -C "$TMP/x" --no-same-owner || fail "could not unpack the bundle"
for d in server systemd ops-dashboard templates; do [[ -d "$TMP/x/$d" ]] || fail "bundle is missing $d/"; done
install -d -m 0755 -o ec2-user -g ec2-user /opt/deploy /opt/deploy/projects /opt/deploy-state /opt/deploy-state/projects
for d in server systemd ops-dashboard templates; do rm -rf "/opt/deploy/$d"; cp -a "$TMP/x/$d" "/opt/deploy/$d"; done
chown -R ec2-user:ec2-user /opt/deploy
install -m 0755 -o root -g root /opt/deploy/server/load-app-secrets.sh /usr/local/bin/load-app-secrets
install -m 0644 /opt/deploy/systemd/app-secrets@.service /etc/systemd/system/app-secrets@.service
install -d -m 0755 /etc/systemd/system/app-secrets@.service.d
printf '[Service]\nEnvironment=AWS_REGION=%s\n' "$REGION" > /etc/systemd/system/app-secrets@.service.d/region.conf
printf 'export AWS_REGION=%s\n' "$REGION" > /etc/profile.d/ops-console.sh
systemctl daemon-reload
did "server files (pipeline, settings loader, status agent, backups) in /opt/deploy"

# ------------------------------------------------------------------ status agent
STEP=agent
id opsdash >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /sbin/nologin opsdash
MPW="$(aws ssm get-parameter --region "$REGION" --name /apps/ops-dashboard/PGPASSWORD --with-decryption --query Parameter.Value --output text 2>/dev/null)" \
  || fail "missing SSM /apps/ops-dashboard/PGPASSWORD (the console sets it before preparing)"
[[ "$MPW" =~ ^[A-Za-z0-9_-]{24,}$ ]] || fail "PGPASSWORD has an unexpected format"
psql -X -q -h localhost -U postgres -w -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL || fail "could not create the read-only monitoring role"
DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_monitor') THEN CREATE ROLE ops_monitor LOGIN; END IF; END \$\$;
ALTER ROLE ops_monitor WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$MPW' CONNECTION LIMIT 5;
GRANT pg_monitor TO ops_monitor;
SQL
unset MPW
install -m 0644 /opt/deploy/systemd/ops-dashboard.service /etc/systemd/system/ops-dashboard.service
systemctl daemon-reload
systemctl enable --quiet ops-dashboard && systemctl restart ops-dashboard || fail "the status agent did not start"
for _ in $(seq 1 20); do curl -fsS -m 2 http://127.0.0.1:9100/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 2 http://127.0.0.1:9100/healthz >/dev/null || { journalctl -u ops-dashboard -n 15 --no-pager; fail "the status agent is not answering"; }
did "status agent on 127.0.0.1:9100 (read-only)"

# ------------------------------------------------------------------ backups, web server
STEP=backups
install -d -m 0700 -o ec2-user -g ec2-user /var/backups/app-db
install -m 0644 /opt/deploy/systemd/db-backup.service /etc/systemd/system/db-backup.service
install -m 0644 /opt/deploy/systemd/db-backup.timer /etc/systemd/system/db-backup.timer
systemctl daemon-reload && systemctl enable --quiet --now db-backup.timer || fail "could not enable the backup timer"
did "nightly database backups (kept 14 days on this server)"

STEP=nginx
systemctl enable --quiet --now nginx || fail "nginx did not start"
nginx -t >/dev/null 2>&1 || fail "the nginx configuration test failed"
did "nginx running"

STEP=done
log "server is ready"
emit 1 done "" "$NODEV" "${DONE[@]}"
