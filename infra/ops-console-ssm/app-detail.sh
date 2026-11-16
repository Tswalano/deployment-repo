#!/bin/bash
# OpsConsole-AppDetail: full read-only view of ONE project from the local ops agent (127.0.0.1:9100/api/app/<p>):
# unit, health, git (commits, commits waiting on origin), deploy history, database metrics and tables.
# fetch=yes first runs `git fetch origin <branch>` as ec2-user so "commits waiting" is current
# (it only updates remote-tracking refs; the working tree and the running app are untouched).
# Output: base64(gzip(JSON)), compacted to stay under SSM's 24 KB output limit.
set -u
export LC_ALL=C
PROJECT='{{ project }}'
FETCH='{{ fetch }}'

fail() { echo "ops-console: $*" >&2; exit 2; }
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "invalid project"
[[ "$FETCH" == yes || "$FETCH" == no ]] || fail "invalid fetch"
CONF="/opt/deploy/projects/$PROJECT.conf"
[[ -f "$CONF" ]] || fail "unknown project '$PROJECT'"

fetch_error=""
if [[ "$FETCH" == yes ]]; then
  SRC="$(sed -n 's/^SOURCE_DIR="\([A-Za-z0-9_./-]*\)".*/\1/p' "$CONF" | head -1)"
  BR="$(sed -n 's/^BRANCH="\([A-Za-z0-9._/-]*\)".*/\1/p' "$CONF" | head -1)"; BR="${BR:-main}"
  if [[ -n "$SRC" && -d "$SRC/.git" ]]; then
    timeout 25 runuser -u ec2-user -- env -i HOME=/home/ec2-user PATH=/usr/bin:/bin \
      git -C "$SRC" fetch --quiet origin "$BR" </dev/null >/dev/null 2>&1 || fetch_error="git fetch failed"
  else
    fetch_error="no git checkout"
  fi
fi

curl -sf -m 30 "http://127.0.0.1:9100/api/app/$PROJECT" | FETCH_ERROR="$fetch_error" python3 -I -c '
import json, os, sys
d = json.load(sys.stdin)
cut = lambda xs, n: (xs or [])[:n]
d["deploys"] = cut(d.get("deploys"), 30)
g = d.get("git") or {}
for k, n in (("commits", 15), ("upstream_commits", 20), ("dirty_files", 20)):
    if k in g: g[k] = cut(g[k], n)
h = d.get("health") or {}
if h.get("body"): h["body"] = h["body"][:800]
w = d.get("warnings_24h")
if isinstance(w, dict): w.pop("last", None)
db = d.get("database") or {}
if isinstance(db.get("tables"), list): db["tables"] = db["tables"][:60]
if isinstance(db.get("connections"), list): db["connections"] = db["connections"][:20]
d["fetch_error"] = os.environ.get("FETCH_ERROR") or None
sys.stdout.write(json.dumps(d, separators=(",", ":")))
' | gzip -9c | base64 -w0
[[ "${PIPESTATUS[0]}" == 0 ]] || fail "ops agent unavailable on 127.0.0.1:9100"
