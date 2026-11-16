#!/bin/bash
# OpsConsole-CollectStatus: read-only status snapshot of this instance, for the Ops Console.
# Runs as root via SSM, takes NO parameters, changes nothing. Output: base64(gzip(JSON)).
#   source "agent": the local ops agent (127.0.0.1:9100, the per-instance dashboard), compacted
#   source "basic": host metrics only, when no agent is installed
set -u
export LC_ALL=C
if raw="$(curl -sf -m 8 http://127.0.0.1:9100/api/status 2>/dev/null)" && [ -n "$raw" ]; then
  src=agent
else
  src=basic
  raw="$(python3 - <<'PY'
import json, os, socket, subprocess, time
mem = {}
for line in open('/proc/meminfo'):
    k, v = line.split(':', 1); mem[k] = int(v.split()[0]) * 1024
st = os.statvfs('/')
up = float(open('/proc/uptime').read().split()[0])
units = subprocess.run(['systemctl', 'list-units', '--type=service', '--state=running', '--no-legend', '--plain'],
                       capture_output=True, text=True).stdout.splitlines()
print(json.dumps({
  'host': {'hostname': socket.gethostname(), 'uptime_seconds': int(up), 'cpus': os.cpu_count(),
           'load': [round(x, 2) for x in os.getloadavg()],
           'memory': {'total': mem['MemTotal'], 'available': mem['MemAvailable'], 'used': mem['MemTotal'] - mem['MemAvailable']},
           'swap': {'total': mem['SwapTotal'], 'used': mem['SwapTotal'] - mem['SwapFree']},
           'disk': {'total': st.f_blocks * st.f_frsize, 'used': (st.f_blocks - st.f_bfree) * st.f_frsize, 'free': st.f_bavail * st.f_frsize}},
  'running_services': len(units),
}))
PY
)"
fi
printf '%s' "$raw" | SRC="$src" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
for p in d.get("projects", []):                     # never ship log lines off the box
    (p.get("warnings_24h") or {}).pop("last", None)
d["deploy_events"] = (d.get("deploy_events") or [])[:15]
print(json.dumps({"source": os.environ["SRC"], "data": d}, separators=(",", ":")))
' | gzip -9c | base64 -w0
