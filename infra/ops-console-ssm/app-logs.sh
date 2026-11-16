#!/bin/bash
# OpsConsole-AppLogs: recent log entries of ONE project's systemd unit, read-only.
# Filters: level (all|warning|error), since (15m|1h|6h|24h|7d|boot), q (plain-text search), lines (10-1000).
# Uses the local ops agent (levels inferred from the text, as journald stores stdout as INFO);
# falls back to journalctl if the agent is down. Obvious secrets (bearer tokens, password/token/secret/
# api-key values, passwords inside URLs) are masked before anything leaves the box.
# Output: base64(gzip(JSON {entries:[{ts,level,source,message}], by_level, source})), under 24 KB.
set -u
export LC_ALL=C
PROJECT='{{ project }}'
LINES='{{ lines }}'
LEVEL='{{ level }}'
SINCE='{{ since }}'
Q='{{ q }}'

fail() { echo "ops-console: $*" >&2; exit 2; }
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "invalid project"
[[ "$LINES" =~ ^[0-9]{2,4}$ ]] && (( LINES >= 10 && LINES <= 1000 )) || fail "lines must be 10-1000"
case "$LEVEL" in all|warning|error) ;; *) fail "invalid level" ;; esac
case "$SINCE" in 15m|1h|6h|24h|7d|boot) ;; *) fail "invalid since" ;; esac
[[ "$Q" =~ ^[A-Za-z0-9\ ._:/@#=-]{0,60}$ ]] || fail "invalid search"
CONF="/opt/deploy/projects/$PROJECT.conf"
[[ -f "$CONF" ]] || fail "unknown project '$PROJECT'"
SERVICE="$(sed -n 's/^SERVICE="\([A-Za-z0-9_.@-]*\)".*/\1/p' "$CONF" | head -1)"
[[ -n "$SERVICE" ]] || fail "no SERVICE in $PROJECT.conf"

P="$PROJECT" N="$LINES" LV="$LEVEL" S="$SINCE" Q="$Q" U="$SERVICE" python3 -I -c '
import base64, gzip, json, os, re, subprocess, urllib.parse, urllib.request
e = os.environ
prio = {"all": 7, "warning": 4, "error": 3}[e["LV"]]
qs = urllib.parse.urlencode({"lines": e["N"], "priority": prio, "since": e["S"], "q": e["Q"]})
source = "agent"
try:
    with urllib.request.urlopen("http://127.0.0.1:9100/api/app/%s/logs?%s" % (e["P"], qs), timeout=25) as r:
        entries = json.load(r)["entries"]
except Exception:
    source = "journalctl"
    since = {"15m": "-15min", "1h": "-1h", "6h": "-6h", "24h": "-24h", "7d": "-7d"}.get(e["S"])
    cmd = ["journalctl", "-u", e["U"], "-o", "json", "--no-pager", "-q", "-n", e["N"]] + (["--since", since] if since else ["-b"])
    entries = []
    for line in subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.splitlines():
        try: j = json.loads(line)
        except ValueError: continue
        msg = j.get("MESSAGE", "")
        if isinstance(msg, list): msg = bytes(msg).decode(errors="replace")
        if e["Q"] and e["Q"].lower() not in msg.lower(): continue
        lvl = int(j.get("PRIORITY", 6))
        if lvl > prio: continue
        entries.append({"ts": int(j.get("__REALTIME_TIMESTAMP", "0")) // 1000, "priority": lvl,
                        "source": j.get("SYSLOG_IDENTIFIER", ""), "message": msg})
R = [
    (re.compile(r"\x1b\[[0-9;?]*[A-Za-z]"), ""),
    (re.compile(r"([Bb]earer\s+)[A-Za-z0-9._~+/=-]+"), r"\1[redacted]"),
    (re.compile(r"((?:password|passwd|secret|token|api[_-]?key|authorization)[\"\x27]?\s*[:=]\s*[\"\x27]?)[^\"\x27\s,}]+", re.I), r"\1[redacted]"),
    (re.compile(r"(://[^:/@\s]+:)[^@/\s]+@"), r"\1[redacted]@"),
]
def clean(m):
    for rx, rep in R: m = rx.sub(rep, m)
    return m[:1000]
name = {0: "error", 1: "error", 2: "error", 3: "error", 4: "warning", 5: "info", 6: "info", 7: "debug"}
out = [{"ts": x.get("ts"), "level": name.get(int(x.get("priority", 6)), "info"), "source": (x.get("source") or "")[:40],
        "message": clean(x.get("message") or "")} for x in entries]
counts = {}
for x in out: counts[x["level"]] = counts.get(x["level"], 0) + 1
def pack(items):
    raw = json.dumps({"entries": items, "by_level": counts, "source": source, "truncated": len(items) < len(out)}, separators=(",", ":"))
    return base64.b64encode(gzip.compress(raw.encode(), 9)).decode()
blob = pack(out)
while len(blob) > 22000 and out:
    out = out[len(out) // 4 or 1:]          # keep the newest entries
    blob = pack(out)
print(blob, end="")
'
