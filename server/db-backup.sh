#!/usr/bin/env bash
# =============================================================================
# db-backup.sh: nightly pg_dump of every project database (run by db-backup.timer as ec2-user).
#   /var/backups/app-db/<db>/<db>-<UTC timestamp>.dump   custom format (pg_restore-able), 0600
#   /var/backups/app-db/_globals/globals-<ts>.sql         roles (pg_dumpall --globals-only), 0600
#   /opt/deploy-state/backups.json                         status for the ops dashboard (no data)
#   /opt/deploy-state/offsite.json                         status of the off-site copies (no data)
# Databases: DB_NAME of every project conf (repo projects and console-created apps), plus any listed one per line
# in /opt/deploy-state/backup-extra-dbs (e.g. the console's own database).
#
# Off-site copies (optional, /etc/ops-console/offsite.env with BUCKET= and BUCKET_REGION=, written by the console):
# every dump is copied to s3://<bucket>/<instance id>/<db>/<file> (the server may add and read copies, never delete
# them; the bucket's lifecycle ages them out), and once a day the previous day's system logs to .../logs/<day>.log.gz. A copied dump is kept here KEEP_LOCAL_DAYS (default 3); one that
# hasn't been copied yet is kept KEEP_DAYS (default 14), as before.
#   db-backup.sh --offsite-only   copy what hasn't been copied yet and prune, without taking new dumps
# Restore one DB:  pg_restore -h localhost -U postgres -d <db> --clean --if-exists <file.dump>
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${STATE_ROOT:-/opt/deploy-state}"
DEST="${BACKUP_DIR:-/var/backups/app-db}"
KEEP_DAYS="${KEEP_DAYS:-14}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-3}"
STATUS="$STATE/backups.json"
OFFSITE_STATUS="$STATE/offsite.json"
OFFSITE_CONF="${OFFSITE_CONF:-/etc/ops-console/offsite.env}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
ONLY_OFFSITE=0; [[ "${1:-}" == --offsite-only ]] && ONLY_OFFSITE=1
umask 077
cd /tmp

failed=0
if [[ $ONLY_OFFSITE == 0 ]]; then
  mapfile -t DBS < <({
    for c in "$ROOT"/projects/*.conf "$STATE"/projects/*.conf; do
      [[ -f "$c" && "$(basename "$c")" != _* ]] || continue
      sed -n 's/^DB_NAME="\{0,1\}\([a-z0-9_]*\)"\{0,1\}.*/\1/p' "$c" | head -1
    done
    [[ -f "$STATE/backup-extra-dbs" ]] && grep -E '^[a-z0-9_]{1,40}$' "$STATE/backup-extra-dbs"
  } | grep . | sort -u)

  results=()
  dump() { # dump <label> <file> <cmd...>
    local label=$1 file=$2; shift 2; local t0=$SECONDS
    if "$@" > "$file.part" 2> "$file.err" && [[ -s "$file.part" ]]; then
      mv "$file.part" "$file"; rm -f "$file.err"
      results+=("$(printf '{"name":"%s","ok":true,"file":"%s","bytes":%s,"seconds":%s}' "$label" "$(basename "$file")" "$(stat -c %s "$file")" $((SECONDS - t0)))")
      echo "✔ $label → $file ($(du -h "$file" | cut -f1))"
    else
      echo "✘ $label failed: $(head -c 300 "$file.err" 2>/dev/null)" >&2
      rm -f "$file.part"
      results+=("$(printf '{"name":"%s","ok":false}' "$label")"); failed=1
    fi
  }

  for db in "${DBS[@]}"; do
    mkdir -p "$DEST/$db"
    dump "$db" "$DEST/$db/$db-$TS.dump" pg_dump -h localhost -U postgres -w -Fc --no-owner "$db"
  done
  mkdir -p "$DEST/_globals"
  dump "_globals" "$DEST/_globals/globals-$TS.sql" pg_dumpall -h localhost -U postgres -w --globals-only
fi

# ------------------------------------------------------------------ off-site copies
BUCKET=""; BUCKET_REGION=""
if [[ -r "$OFFSITE_CONF" ]]; then
  BUCKET="$(sed -n 's/^BUCKET=\(ops-console-backups-[0-9]\{12\}-[a-z0-9-]\{1,30\}\)$/\1/p' "$OFFSITE_CONF" | head -1)"
  BUCKET_REGION="$(sed -n 's/^BUCKET_REGION=\([a-z]\{2\}-[a-z]\{1,12\}-[0-9]\)$/\1/p' "$OFFSITE_CONF" | head -1)"
fi
copied=0; pending=0; offsite_err=""
if [[ -n "$BUCKET" && -n "$BUCKET_REGION" ]]; then
  [[ -n "${INSTANCE_ID:-}" ]] || IMDS_TOKEN="$(curl -s -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
  IID="${INSTANCE_ID:-$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)}"
  if [[ ! "$IID" =~ ^i-[0-9a-f]{8,17}$ ]]; then
    offsite_err="cannot read this server's instance id"
  else
    while IFS= read -r f; do
      [[ -e "$f.offsite" ]] && continue
      rel="${f#"$DEST"/}"
      if out="$(aws s3 cp --only-show-errors --region "$BUCKET_REGION" --sse AES256 --content-type application/octet-stream \
                 "$f" "s3://$BUCKET/$IID/$rel" 2>&1)"; then
        touch "$f.offsite"; copied=$((copied + 1))
      else
        pending=$((pending + 1)); offsite_err="$(echo "$out" | tail -1 | tr -d '"\\' | cut -c1-200)"
      fi
    done < <(find "$DEST" -mindepth 2 -maxdepth 2 -type f \( -name '*.dump' -o -name '*.sql' \) | sort)
    [[ -n "$offsite_err" ]] && echo "✘ off-site copy: $offsite_err" >&2 || echo "✔ off-site: $copied new copies in s3://$BUCKET/$IID/"
    # yesterday's system logs (journald keeps only ~200 MB on the server): once a day, s3://<bucket>/<instance id>/logs/<day>.log.gz
    DAY="$(date -u -d yesterday +%F)"; MARK="$STATE/logs-exported"
    if [[ "$(cat "$MARK" 2>/dev/null)" != "$DAY" ]]; then
      if sudo -n journalctl --since "$DAY 00:00:00 UTC" --until "$(date -u +%F) 00:00:00 UTC" -o short-iso 2>/dev/null | gzip -9 > /tmp/opslogs.$$.gz \
         && aws s3 cp --only-show-errors --region "$BUCKET_REGION" --sse AES256 /tmp/opslogs.$$.gz "s3://$BUCKET/$IID/logs/$DAY.log.gz" 2>/dev/null; then
        echo "$DAY" > "$MARK"; echo "✔ system logs of $DAY copied"
      else echo "✘ could not copy the system logs of $DAY (retried next run)" >&2; fi
      rm -f /tmp/opslogs.$$.gz
    fi
  fi
fi

# ------------------------------------------------------------------ prune: copied dumps after KEEP_LOCAL_DAYS, others after KEEP_DAYS
while IFS= read -r f; do
  if [[ -e "$f.offsite" ]]; then
    [[ -n "$(find "$f" -mtime +"$KEEP_LOCAL_DAYS" -print)" ]] && rm -f "$f" "$f.offsite"
  else
    [[ -n "$(find "$f" -mtime +"$KEEP_DAYS" -print)" ]] && rm -f "$f"
  fi
done < <(find "$DEST" -mindepth 2 -maxdepth 2 -type f \( -name '*.dump' -o -name '*.sql' \))
find "$DEST" -mindepth 2 -maxdepth 2 -name '*.offsite' | while IFS= read -r m; do [[ -e "${m%.offsite}" ]] || rm -f "$m"; done
find "$DEST" -name '*.err' -delete

local_pending="$(find "$DEST" -mindepth 2 -maxdepth 2 -type f \( -name '*.dump' -o -name '*.sql' \) | while IFS= read -r f; do [[ -e "$f.offsite" ]] || echo x; done | wc -l)"
python3 -I -c '
import json, os, sys
p, bucket, region, copied, pending, err, keep_local, keep = sys.argv[1:9]
import time
s = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "configured": bool(bucket), "bucket": bucket or None,
     "region": region or None, "copied": int(copied), "pending": int(pending), "ok": bool(bucket) and not err, "error": err or None,
     "keep_local_days": int(keep_local), "keep_days": int(keep)}
tmp = p + ".tmp"
with open(tmp, "w") as f: json.dump(s, f)
os.chmod(tmp, 0o644); os.replace(tmp, p)
' "$OFFSITE_STATUS" "$BUCKET" "$BUCKET_REGION" "$copied" "$local_pending" "$offsite_err" "$KEEP_LOCAL_DAYS" "$KEEP_DAYS"

[[ $ONLY_OFFSITE == 1 ]] && exit 0
total="$(du -sb "$DEST" | cut -f1)"
printf '{"at":"%s","ok":%s,"keep_days":%s,"total_bytes":%s,"location":"%s","items":[%s]}\n' \
  "$(date -u +%FT%TZ)" "$([[ $failed == 0 ]] && echo true || echo false)" "$KEEP_DAYS" "$total" "$DEST" \
  "$(IFS=,; echo "${results[*]}")" > "$STATUS.tmp" && chmod 644 "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
exit $failed
