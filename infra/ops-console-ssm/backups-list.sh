#!/bin/bash
# OpsConsole-Backups: read-only inventory of the nightly database dumps on this instance.
# No parameters. Lists files under /var/backups/app-db (names, sizes, times only, never contents),
# the last run's status, the timer schedule, restore-test results and free disk space.
# Output: base64(gzip(JSON)).
set -u
export LC_ALL=C
NEXT="$(systemctl show db-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null)"
LAST="$(systemctl show db-backup.timer -p LastTriggerUSec --value 2>/dev/null)"
ACTIVE="$(systemctl is-active db-backup.service 2>/dev/null)"
NEXT="$NEXT" LAST="$LAST" ACTIVE="$ACTIVE" python3 -I -c '
import base64, gzip, json, os
root = "/var/backups/app-db"
def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return None
files = []
if os.path.isdir(root):
    for db in sorted(os.listdir(root)):
        d = os.path.join(root, db)
        if not os.path.isdir(d): continue
        for name in os.listdir(d):
            if not (name.endswith(".dump") or name.endswith(".sql")): continue
            st = os.stat(os.path.join(d, name))
            files.append({"db": db, "file": name, "bytes": st.st_size, "mtime": int(st.st_mtime)})
files.sort(key=lambda x: (x["db"], -x["mtime"]))
vfs = os.statvfs("/")
out = {
    "status": load("/opt/deploy-state/backups.json"),
    "verifications": (load("/opt/deploy-state/backup-verify.json") or [])[-100:],
    "files": files,
    "timer": {"next": os.environ.get("NEXT") or None, "last": os.environ.get("LAST") or None, "running": os.environ.get("ACTIVE") == "activating"},
    "disk_free": vfs.f_bavail * vfs.f_frsize,
    "location": root,
}
print(base64.b64encode(gzip.compress(json.dumps(out, separators=(",", ":")).encode(), 9)).decode(), end="")
'
