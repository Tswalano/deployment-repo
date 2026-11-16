#!/bin/bash
# OpsConsole-BackupAction: one backup operation. Never writes to a live database.
#   action=run     start db-backup.service now (the same nightly pg_dump job) and wait for it
#   action=verify  restore <db>/<file> into a throwaway database "opsverify_<db>_<epoch>", count its tables
#                  and rows, compare with the live database, then DROP the throwaway database
#   action=export  copy <db>/<file> to s3://<bucket>/<key> (private, encrypted) for a short-lived download link
# Parameters are pinned by allowedPattern in the document and re-checked here. Output: one JSON line.
set -u
export LC_ALL=C
ACTION='{{ action }}'
DB='{{ db }}'
FILE='{{ file }}'
BUCKET='{{ bucket }}'
KEY='{{ key }}'
ROOT=/var/backups/app-db
RESULTS=/opt/deploy-state/backup-verify.json

fail() { printf '{"ok":false,"error":"%s"}\n' "$*"; exit 2; }
case "$ACTION" in run|verify|export) ;; *) fail "unknown action" ;; esac

if [[ "$ACTION" == run ]]; then
  t0=$SECONDS
  systemctl start db-backup.service; rc=$?
  python3 -I -c 'import json,sys; s=json.load(open("/opt/deploy-state/backups.json")); print(json.dumps({"ok": sys.argv[1]=="0" and s.get("ok") is True, "seconds": int(sys.argv[2]), "status": s}))' "$rc" "$((SECONDS - t0))" \
    || fail "backup finished with code $rc but no status was written"
  exit 0
fi

[[ "$DB" =~ ^[a-z0-9_]{1,40}$ && "$DB" != _globals ]] || fail "invalid database"
[[ "$FILE" =~ ^[A-Za-z0-9_.-]{1,120}\.dump$ ]] || fail "invalid file"
PATH_="$ROOT/$DB/$FILE"
[[ -f "$PATH_" && "$(realpath "$PATH_")" == "$ROOT/$DB/$FILE" ]] || fail "no such backup"

if [[ "$ACTION" == export ]]; then
  [[ "$BUCKET" =~ ^ops-console-transfer-[0-9]{12}-[a-z0-9-]{1,30}$ ]] || fail "invalid bucket"
  [[ "$KEY" =~ ^downloads/[0-9a-f]{32}/[A-Za-z0-9_.-]{1,120}$ ]] || fail "invalid key"
  sum="$(sha256sum "$PATH_" | cut -d' ' -f1)"
  aws s3 cp --only-show-errors --sse AES256 --content-type application/octet-stream "$PATH_" "s3://$BUCKET/$KEY" 2>&1 >/dev/null | head -c 300 > /tmp/opsexport.err
  [[ -s /tmp/opsexport.err ]] && { e="$(tr -d '"\n' < /tmp/opsexport.err)"; rm -f /tmp/opsexport.err; fail "upload failed: $e"; }
  rm -f /tmp/opsexport.err
  printf '{"ok":true,"bytes":%s,"sha256":"%s"}\n' "$(stat -c %s "$PATH_")" "$sum"
  exit 0
fi

# ---- verify: restore into a throwaway database as ec2-user (credentials in ~/.pgpass)
SCRATCH="opsverify_${DB:0:30}_$(date +%s)"
pg() { runuser -u ec2-user -- env -i HOME=/home/ec2-user PATH=/usr/bin:/bin "$@"; }
psqlq() { pg psql -X -q -tA -h localhost -U postgres -w -v ON_ERROR_STOP=1 "$@"; }
cleanup() { psqlq -d postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1; }
trap cleanup EXIT
COUNT_SQL="SELECT count(*), coalesce(sum((xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint), 0)
           FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')"
t0=$SECONDS
psqlq -d postgres -c "CREATE DATABASE \"$SCRATCH\"" >/dev/null 2>/tmp/opsverify.err || fail "could not create scratch database: $(tr -d '"\n' < /tmp/opsverify.err | head -c 200)"
pg pg_restore -h localhost -U postgres -w --no-owner --no-acl --exit-on-error -d "$SCRATCH" "$PATH_" 2>/tmp/opsverify.err
rc=$?
err="$(tr -d '"\\\n' < /tmp/opsverify.err | head -c 300)"; rm -f /tmp/opsverify.err
read -r tables rows < <(psqlq -d "$SCRATCH" -F ' ' -c "$COUNT_SQL" 2>/dev/null || echo "0 0")
read -r live_tables live_rows < <(psqlq -d "$DB" -F ' ' -c "$COUNT_SQL" 2>/dev/null || echo "0 0")
secs=$((SECONDS - t0))
cleanup
ok=false; [[ $rc == 0 && ${tables:-0} -gt 0 ]] && ok=true
line="$(printf '{"at":"%s","db":"%s","file":"%s","ok":%s,"tables":%s,"rows":%s,"live_tables":%s,"live_rows":%s,"seconds":%s,"error":"%s"}' \
  "$(date -u +%FT%TZ)" "$DB" "$FILE" "$ok" "${tables:-0}" "${rows:-0}" "${live_tables:-0}" "${live_rows:-0}" "$secs" "$err")"
python3 -I -c '
import json, os, sys
p, line = sys.argv[1], json.loads(sys.argv[2])
try: data = json.load(open(p))
except Exception: data = []
data = (data + [line])[-200:]
tmp = p + ".tmp"
with open(tmp, "w") as f: json.dump(data, f)
os.chmod(tmp, 0o644); os.replace(tmp, p)
' "$RESULTS" "$line"
echo "$line"
