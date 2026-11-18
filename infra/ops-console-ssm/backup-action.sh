#!/bin/bash
# OpsConsole-BackupAction: one backup operation. Never writes to a live database.
#   action=run     start db-backup.service now (the same nightly pg_dump job) and wait for it
#   action=verify  restore <db>/<file> into a throwaway database "opsverify_<db>_<epoch>", count its tables
#                  and rows, compare with the live database, then DROP the throwaway database
#   action=export  copy <db>/<file> to s3://<bucket>/<key> (private, encrypted) for a short-lived download link
#   action=offsite copy every nightly dump to s3://<bucket> (ops-console-backups-<account>-<region>) from now on, and
#                  catch up now; an empty bucket switches it off. Writes /etc/ops-console/offsite.env.
#   action=fetch   bring one off-site copy (<key> = <this instance id>/<db>/<file>.dump) back into the local backups,
#                  e.g. to restore-test it; never overwrites a local file
# Parameters are pinned by allowedPattern in the document and re-checked here. Output: one JSON line.
set -u
export LC_ALL=C
ACTION='{{ action }}'
DB='{{ db }}'
FILE='{{ file }}'
BUCKET='{{ bucket }}'
KEY='{{ key }}'
BREGION='{{ region }}'
ROOT=/var/backups/app-db
RESULTS=/opt/deploy-state/backup-verify.json

fail() { printf '{"ok":false,"error":"%s"}\n' "$*"; exit 2; }
case "$ACTION" in run|verify|export|offsite|fetch) ;; *) fail "unknown action" ;; esac
SCRIPT=/opt/deploy/server/db-backup.sh
asec2() { runuser -u ec2-user -- env -i HOME=/home/ec2-user PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
valid_bucket() { [[ "$BUCKET" =~ ^ops-console-backups-[0-9]{12}-[a-z0-9-]{1,30}$ && "$BREGION" =~ ^[a-z]{2}-[a-z]{1,12}-[0-9]$ ]]; }

if [[ "$ACTION" == offsite ]]; then
  if [[ -z "$BUCKET" ]]; then rm -f /etc/ops-console/offsite.env
  else
    valid_bucket || fail "invalid bucket or region"
    install -d -m 0755 /etc/ops-console
    printf 'BUCKET=%s\nBUCKET_REGION=%s\n' "$BUCKET" "$BREGION" > /etc/ops-console/offsite.env.tmp && chmod 0644 /etc/ops-console/offsite.env.tmp \
      && mv /etc/ops-console/offsite.env.tmp /etc/ops-console/offsite.env || fail "could not save the setting"
  fi
  [[ -x "$SCRIPT" || -f "$SCRIPT" ]] || fail "the backup script is missing on this server (prepare the server again)"
  asec2 bash "$SCRIPT" --offsite-only >/tmp/opsoffsite.log 2>&1
  python3 -I -c 'import json; s=json.load(open("/opt/deploy-state/offsite.json")); print(json.dumps({"ok": (not s.get("configured")) or s.get("ok") is True, "offsite": s}))' \
    || fail "no off-site status was written"
  exit 0
fi

if [[ "$ACTION" == fetch ]]; then
  valid_bucket || fail "invalid bucket or region"
  IMDS_TOKEN="$(curl -s -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
  IID="$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"
  [[ "$KEY" =~ ^(i-[0-9a-f]{8,17})/([a-z0-9_]{1,40})/([A-Za-z0-9_.-]{1,120}\.dump)$ ]] || fail "invalid key"
  [[ "${BASH_REMATCH[1]}" == "$IID" ]] || fail "that copy belongs to another server"
  FDB="${BASH_REMATCH[2]}"; FFILE="${BASH_REMATCH[3]}"; DESTF="$ROOT/$FDB/$FFILE"
  if [[ ! -f "$DESTF" ]]; then
    install -d -m 0700 -o ec2-user -g ec2-user "$ROOT/$FDB"
    asec2 aws s3 cp --only-show-errors --region "$BREGION" "s3://$BUCKET/$KEY" "$DESTF.part" >/tmp/opsfetch.err 2>&1 \
      || { e="$(tail -1 /tmp/opsfetch.err | tr -d '"\\' | cut -c1-200)"; rm -f "$DESTF.part" /tmp/opsfetch.err; fail "download failed: $e"; }
    rm -f /tmp/opsfetch.err
    mv "$DESTF.part" "$DESTF" && chmod 0600 "$DESTF" && asec2 touch "$DESTF.offsite"   # already off-site: pruned after the usual few days
  fi
  printf '{"ok":true,"db":"%s","file":"%s","bytes":%s}\n' "$FDB" "$FFILE" "$(stat -c %s "$DESTF")"
  exit 0
fi

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
