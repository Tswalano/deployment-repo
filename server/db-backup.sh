#!/usr/bin/env bash
# =============================================================================
# db-backup.sh: nightly pg_dump of every project database (run by db-backup.timer as ec2-user).
#   /var/backups/app-db/<db>/<db>-<UTC timestamp>.dump   custom format (pg_restore-able), 0600
#   /var/backups/app-db/_globals/globals-<ts>.sql         roles (pg_dumpall --globals-only), 0600
#   /opt/deploy-state/backups.json                         status for the ops dashboard (no data)
# Keeps KEEP_DAYS (default 14). Credentials: ~/.pgpass. Free: stays on the instance's own disk,
# so it protects against bad deploys and mistakes, NOT against losing the volume itself.
# Restore one DB:  pg_restore -h localhost -U postgres -d <db> --clean --if-exists <file.dump>
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${BACKUP_DIR:-/var/backups/app-db}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STATUS="${STATE_ROOT:-/opt/deploy-state}/backups.json"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
cd /tmp

mapfile -t DBS < <(for c in "$ROOT"/projects/*.conf; do [[ "$(basename "$c")" == _* ]] && continue
  bash -c "source '$c'; echo \"\${DB_NAME:-}\""; done | grep . | sort -u)

results=(); failed=0
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

find "$DEST" -type f \( -name '*.dump' -o -name '*.sql' \) -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name '*.err' -delete

total="$(du -sb "$DEST" | cut -f1)"
printf '{"at":"%s","ok":%s,"keep_days":%s,"total_bytes":%s,"location":"%s","items":[%s]}\n' \
  "$(date -u +%FT%TZ)" "$([[ $failed == 0 ]] && echo true || echo false)" "$KEEP_DAYS" "$total" "$DEST" \
  "$(IFS=,; echo "${results[*]}")" > "$STATUS.tmp" && chmod 644 "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
exit $failed
