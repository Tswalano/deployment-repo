#!/bin/bash
# OpsConsole-CreateApp: set up a NEW Node.js app on this instance from a GitHub repository, then deploy it.
#   clone (as ec2-user, private repos through a short-lived token the console leaves in SSM) → pick a free port →
#   project conf in /opt/deploy-state/projects (survives deploy.sh's rsync) → SSM /apps/<p>/{PORT,NODE_ENV}
#   → optional Postgres role + database (password generated here, DATABASE_URL straight to SSM)
#   → systemd unit → nginx vhost → HTTPS (certbot) once DNS points here → pipeline.sh deploy <p>.
# Anything that fails rolls back everything this run created. Refuses if the project, unit, folder or vhost exists.
# Every parameter is pinned by allowedPattern in the document and re-checked here.
# Output: the run log (colour-free, last 20 KB) and a final JSON summary line. Secrets are never printed.
set -u
export LC_ALL=C
PROJECT='{{ project }}'
REPO='{{ repo }}'
BRANCH='{{ branch }}'
SUBDIR='{{ appSubdir }}'
START='{{ startScript }}'
BUILD='{{ build }}'
MIGRATE='{{ migrateScript }}'
HEALTH='{{ healthPath }}'
DOMAIN='{{ domain }}'
DB='{{ db }}'
MEM='{{ memoryMb }}'
ACTOR='{{ actor }}'

LOG="$(mktemp /tmp/opsconsole-create.XXXXXX)"
exec 3>&1 >"$LOG" 2>&1
STEP=validate
CREATED=()          # what to undo on failure, in order
PORT=""; TLS=false; DBNAME=""; DBROLE=""
TOKDIR=/run/ops-console/git
STATE_PROJ=/opt/deploy-state/projects
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

summary() { # summary <ok> [error]
  rm -f "$TOKDIR/$PROJECT.token"
  sed 's/\x1b\[[0-9;]*m//g' "$LOG" | tail -c 20000 >&3
  python3 -I -c 'import json,sys; ok=sys.argv[1]=="true"; print(json.dumps({"ok": ok, "step": sys.argv[2], "error": sys.argv[3] or None, "port": int(sys.argv[4]) if sys.argv[4] else None, "tls": sys.argv[5]=="true", "database": sys.argv[6] or None, "domain": sys.argv[7]}))' \
    "$1" "$STEP" "${2:-}" "$PORT" "$TLS" "$DBNAME" "$DOMAIN" >&3
  rm -f "$LOG"
}

undo() {
  log "rolling back what this run created"
  local i
  for (( i=${#CREATED[@]}-1; i>=0; i-- )); do
    case "${CREATED[$i]}" in
      unit)   systemctl disable --now "$PROJECT" 2>/dev/null; rm -f "/etc/systemd/system/$PROJECT.service"; rm -rf "/etc/systemd/system/app-secrets@$PROJECT.service.d"; rm -f "/run/app-secrets/$PROJECT.env"; systemctl daemon-reload ;;
      vhost)  rm -f "/etc/nginx/conf.d/$PROJECT.conf"; nginx -t 2>/dev/null && systemctl reload nginx ;;
      cert)   certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null ;;
      db)     printf 'DROP DATABASE IF EXISTS "%s" WITH (FORCE);\nDROP ROLE IF EXISTS "%s";\n' "$DBNAME" "$DBROLE" | pgsu >/dev/null 2>&1 ;;
      ssm)    for k in PORT NODE_ENV DATABASE_URL; do aws ssm delete-parameter --region "$REGION" --name "/apps/$PROJECT/$k" 2>/dev/null; done ;;
      conf)   rm -f "$STATE_PROJ/$PROJECT.conf"; rm -rf "/opt/deploy-state/$PROJECT" ;;   # the pipeline's history/backups dir for this new app
      clone)  rm -rf "/opt/apps/$PROJECT" ;;
    esac
  done
}

fail() { log "✘ $*"; undo; summary false "$*"; exit 1; }
pgsu() { runuser -u ec2-user -- env -i HOME=/home/ec2-user PATH=/usr/bin:/bin psql -X -q -h localhost -U postgres -w -d postgres -v ON_ERROR_STOP=1; }
asec2() { runuser -u ec2-user -- env -i HOME=/home/ec2-user USER=ec2-user LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin "${GITENV[@]}" "$@"; }

# ------------------------------------------------------------------ validate (again; the document already did)
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || fail "invalid project name"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$ ]] || fail "invalid repository"
[[ "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ && "$BRANCH" != *..* ]] || fail "invalid branch"
[[ -z "$SUBDIR" || ( "$SUBDIR" =~ ^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$ && "$SUBDIR" != *..* ) ]] || fail "invalid app folder"
[[ "$START" =~ ^[a-z0-9:_-]{1,40}$ ]] || fail "invalid start script"
[[ -z "$MIGRATE" || "$MIGRATE" =~ ^[a-z0-9:_-]{1,40}$ ]] || fail "invalid migrate script"
[[ "$BUILD" == yes || "$BUILD" == no ]] || fail "invalid build flag"
[[ "$DB" == yes || "$DB" == no ]] || fail "invalid db flag"
[[ "$HEALTH" =~ ^/[A-Za-z0-9._~/-]{0,100}$ ]] || fail "invalid health path"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$ ]] || fail "invalid domain"
[[ "$MEM" =~ ^[0-9]{2,4}$ ]] && (( MEM >= 64 && MEM <= 2048 )) || fail "memory must be 64-2048 MB"
[[ "$ACTOR" =~ ^[A-Za-z0-9._@:-]{1,64}$ ]] || fail "invalid actor"

STEP=checks
[[ -e "/opt/deploy/projects/$PROJECT.conf" || -e "$STATE_PROJ/$PROJECT.conf" ]] && fail "a project called $PROJECT already exists"
[[ -e "/opt/apps/$PROJECT" ]] && fail "/opt/apps/$PROJECT already exists"
# a pipeline state dir without a project conf is left over from an earlier failed attempt: set it aside, never delete it
if [[ -d "/opt/deploy-state/$PROJECT" ]]; then
  install -d -m 0755 /opt/deploy-state/.leftovers
  mv "/opt/deploy-state/$PROJECT" "/opt/deploy-state/.leftovers/$PROJECT-$(date -u +%Y%m%dT%H%M%SZ)"
  log "moved an old pipeline state dir for $PROJECT to /opt/deploy-state/.leftovers/"
fi
systemctl cat "$PROJECT.service" >/dev/null 2>&1 && fail "a systemd unit $PROJECT.service already exists"
[[ -e "/etc/nginx/conf.d/$PROJECT.conf" ]] && fail "an nginx site $PROJECT.conf already exists"
grep -rqsl -E "server_name[^;]*[[:space:]]$DOMAIN[[:space:];]" /etc/nginx/conf.d/ && fail "nginx already serves $DOMAIN"
IMDS_TOKEN="$(curl -s -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 120' http://169.254.169.254/latest/api/token)"
md() { curl -s -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }
REGION="$(md placement/region)"; MYIP="$(md public-ipv4)"
[[ -n "$REGION" ]] || fail "cannot read the instance region"

# ------------------------------------------------------------------ port
STEP=port
PORT="$(python3 -I - <<'PY'
import glob, re, subprocess
used = set()
for f in glob.glob("/opt/deploy/projects/*.conf") + glob.glob("/opt/deploy-state/projects/*.conf"):
    m = re.search(r'HEALTH_URL="https?://[^/:]+:(\d+)', open(f).read())
    if m: used.add(int(m.group(1)))
for line in subprocess.run(["ss", "-ltnH"], capture_output=True, text=True).stdout.splitlines():
    m = re.search(r":(\d+)\s", line.split()[3] + " ") if len(line.split()) > 3 else None
    if m: used.add(int(m.group(1)))
print(next(p for p in range(5000, 6000) if p not in used))
PY
)" || fail "no free port"
log "port $PORT"

# ------------------------------------------------------------------ clone
STEP=clone
GITENV=(GIT_TERMINAL_PROMPT=0)
if tok="$(aws ssm get-parameter --region "$REGION" --name "/ops-console/git-tokens/$PROJECT" --with-decryption --query Parameter.Value --output text 2>/dev/null)" && [[ -n "$tok" && "$tok" != None ]]; then
  install -d -m 0700 -o ec2-user -g ec2-user "$TOKDIR"
  ( umask 077; printf '%s' "$tok" > "$TOKDIR/$PROJECT.token" ); chown ec2-user: "$TOKDIR/$PROJECT.token"
  printf '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) cat "$OPS_GIT_TOKEN_FILE" ;; esac\n' > "$TOKDIR/askpass.sh"
  chmod 0700 "$TOKDIR/askpass.sh"; chown ec2-user: "$TOKDIR/askpass.sh"
  GITENV+=(GIT_ASKPASS="$TOKDIR/askpass.sh" OPS_GIT_TOKEN_FILE="$TOKDIR/$PROJECT.token")
fi
unset tok
install -d -m 0755 -o ec2-user -g ec2-user /opt/apps
CREATED+=(clone)
asec2 git clone --quiet --branch "$BRANCH" "https://github.com/$REPO.git" "/opt/apps/$PROJECT" || fail "git clone failed (does the GitHub App have access to $REPO?)"
APPDIR="/opt/apps/$PROJECT${SUBDIR:+/$SUBDIR}"
[[ -f "$APPDIR/package.json" ]] || fail "no package.json in ${SUBDIR:-the repository root}"
log "cloned $REPO@$BRANCH ($(asec2 git -C "/opt/apps/$PROJECT" rev-parse --short HEAD))"

# ------------------------------------------------------------------ database (optional)
if [[ "$DB" == yes ]]; then
  STEP=database
  DBNAME="${PROJECT//-/_}"; DBROLE="${DBNAME}_user"
  if printf "SELECT 1 FROM pg_database WHERE datname='%s' UNION SELECT 1 FROM pg_roles WHERE rolname='%s';\n" "$DBNAME" "$DBROLE" | runuser -u ec2-user -- env -i HOME=/home/ec2-user PATH=/usr/bin:/bin psql -X -tA -h localhost -U postgres -w -d postgres | grep -q 1; then
    DBNAME=""; fail "a database or role for $PROJECT already exists"
  fi
  PW="$(python3 -I -c 'import secrets; print("".join(c if c.isalnum() else "x" for c in secrets.token_urlsafe(32)))')"
  CREATED+=(db)
  printf 'CREATE ROLE "%s" LOGIN PASSWORD '"'"'%s'"'"' CONNECTION LIMIT 20;\nCREATE DATABASE "%s" OWNER "%s";\nREVOKE CONNECT ON DATABASE "%s" FROM PUBLIC;\nGRANT CONNECT ON DATABASE "%s" TO "%s";\n' \
    "$DBROLE" "$PW" "$DBNAME" "$DBROLE" "$DBNAME" "$DBNAME" "$DBROLE" | pgsu >/dev/null || fail "could not create the database"
  CREATED+=(ssm)
  python3 -I -c 'import json,sys; print(json.dumps({"Name": sys.argv[1], "Value": sys.argv[2], "Type": "SecureString", "Overwrite": True}))' \
    "/apps/$PROJECT/DATABASE_URL" "postgresql://$DBROLE:$PW@127.0.0.1:5432/$DBNAME" \
    | aws ssm put-parameter --region "$REGION" --cli-input-json file:///dev/stdin >/dev/null || fail "could not save DATABASE_URL"
  unset PW
  log "database $DBNAME (role $DBROLE); DATABASE_URL saved to SSM"
fi

# ------------------------------------------------------------------ settings in SSM
STEP=settings
[[ " ${CREATED[*]} " == *" ssm "* ]] || CREATED+=(ssm)
aws ssm put-parameter --region "$REGION" --name "/apps/$PROJECT/PORT" --type String --value "$PORT" --overwrite >/dev/null || fail "could not save PORT"
aws ssm put-parameter --region "$REGION" --name "/apps/$PROJECT/NODE_ENV" --type String --value production --overwrite >/dev/null || fail "could not save NODE_ENV"

# ------------------------------------------------------------------ project conf (pipeline + ops agent)
STEP=conf
install -d -m 0755 -o ec2-user -g ec2-user "$STATE_PROJ"
INSTALL="npm ci --no-audit --no-fund"; [[ -f "$APPDIR/package-lock.json" ]] || INSTALL="npm install --no-audit --no-fund"
CREATED+=(conf)
cat > "$STATE_PROJ/$PROJECT.conf" <<CONF
# Created by the Ops Console (OpsConsole-CreateApp) for $REPO; kept in the state dir so deploy.sh never removes it.
SERVICE="$PROJECT"
SOURCE_DIR="/opt/apps/$PROJECT"
BRANCH="$BRANCH"
APP_SUBDIR="${SUBDIR:-.}"
INSTALL_CMD="$INSTALL"
BUILD_CMD="$([[ "$BUILD" == yes ]] && echo "npm run build")"
MIGRATE_CMD="$([[ -n "$MIGRATE" ]] && echo "npm run $MIGRATE")"
DB_NAME="$DBNAME"
HEALTH_URL="http://127.0.0.1:$PORT$HEALTH"
DOMAIN="$DOMAIN"
CONF
chown ec2-user: "$STATE_PROJ/$PROJECT.conf"; chmod 0644 "$STATE_PROJ/$PROJECT.conf"

# ------------------------------------------------------------------ systemd unit
STEP=service
EXEC="/usr/bin/npm run $START"; [[ "$START" == start ]] && EXEC="/usr/bin/npm start"
CREATED+=(unit)
cat > "/etc/systemd/system/$PROJECT.service" <<UNIT
# Created by the Ops Console for $REPO. Secrets: SSM /apps/$PROJECT/* loaded by app-secrets@$PROJECT.
[Unit]
Description=$PROJECT ($REPO)
Wants=network-online.target
Requires=app-secrets@$PROJECT.service
After=network-online.target postgresql.service app-secrets@$PROJECT.service

[Service]
Type=simple
User=ec2-user
WorkingDirectory=$APPDIR
EnvironmentFile=/run/app-secrets/$PROJECT.env
Environment=NODE_ENV=production PORT=$PORT
ExecStart=$EXEC
Restart=on-failure
RestartSec=5
SuccessExitStatus=143
MemoryMax=${MEM}M

[Install]
WantedBy=multi-user.target
UNIT
# the secrets loader defaults to af-south-1: pin this instance's region for this app
install -d -m 0755 "/etc/systemd/system/app-secrets@$PROJECT.service.d"
printf '[Service]\nEnvironment=AWS_REGION=%s\n' "$REGION" > "/etc/systemd/system/app-secrets@$PROJECT.service.d/region.conf"
systemctl daemon-reload && systemctl enable --quiet "$PROJECT" || fail "could not install the systemd unit"
# load /apps/$PROJECT/* now: the first deploy's migrations read DATABASE_* from it, and it proves SSM access works
systemctl restart "app-secrets@$PROJECT" || fail "could not load the app's settings from SSM (instance role permissions in $REGION?)"

# ------------------------------------------------------------------ nginx + HTTPS
STEP=nginx
CREATED+=(vhost)
cat > "/etc/nginx/conf.d/$PROJECT.conf" <<NGX
# Created by the Ops Console for $REPO
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 20m;
    location / {
        proxy_pass         http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Forwarded-For \$remote_addr;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_read_timeout 60s;
    }
}
NGX
nginx -t && systemctl reload nginx || fail "nginx rejected the new site"

STEP=https
# The console already waited for Route 53 to report the record live; this instance's resolver may still hold an old
# "no such name" answer for a few minutes. Let's Encrypt checks public DNS, so try the certificate either way.
resolved=false
for _ in $(seq 1 60); do [[ "$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)" == "$MYIP" ]] && { resolved=true; break; }; sleep 5; done
$resolved || log "this instance doesn't resolve $DOMAIN yet (DNS cache); trying the certificate anyway"
CREATED+=(cert)
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --register-unsafely-without-email; then TLS=true; log "HTTPS certificate issued for $DOMAIN"
else log "⚠ certbot failed; the app is reachable over HTTP only for now (re-run: sudo certbot --nginx -d $DOMAIN)"; fi

# ------------------------------------------------------------------ first deploy (install, build, migrate, start, health)
STEP=deploy
asec2 DEPLOY_ACTOR="$ACTOR" DEPLOY_TRIGGER=ops-console bash /opt/deploy/server/pipeline.sh deploy "$PROJECT" "$BRANCH" </dev/null || fail "the first deploy failed (see the pipeline output above)"

STEP=done
log "✔ $PROJECT is live at http$([[ $TLS == true ]] && echo s)://$DOMAIN"
summary true
exit 0
