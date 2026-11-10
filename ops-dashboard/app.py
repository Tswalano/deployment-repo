#!/usr/bin/env python3
"""
ops-dashboard — read-only status page for the EC2 app host.

Stdlib only (runs on the system python3.9 of Amazon Linux 2023, ~15 MB RSS).
Binds to 127.0.0.1 only; expose it through nginx (basic auth + TLS) or an SSH/SSM tunnel.

  GET /            → dashboard (HTML, auto-refreshes)
  GET /api/status  → everything as JSON
  GET /healthz     → "ok"

Never executes anything that changes state: systemctl show, git rev-parse/log,
read-only SQL as a pg_monitor role, and HTTP GETs to the apps' health URLs.
"""
import glob
import json
import os
import re
import shlex
import socket
import ssl
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND = os.environ.get("OPS_BIND", "127.0.0.1")
PORT = int(os.environ.get("OPS_PORT", "9100"))
PIPELINE_DIR = os.environ.get("OPS_PIPELINE_DIR", "/opt/deploy")
STATE_DIR = os.environ.get("OPS_STATE_DIR", "/opt/deploy-state")
EXTRA_UNITS = os.environ.get("OPS_EXTRA_UNITS", "nginx postgresql amazon-ssm-agent certbot-renew.timer").split()
PG_USER = os.environ.get("PGUSER", "ops_monitor")
CACHE_SECONDS = 5

HERE = os.path.dirname(os.path.abspath(__file__))


def run(cmd, timeout=8, env=None):
    """Run a read-only command; return stdout ('' on any failure)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""


# --------------------------------------------------------------------------- host
def host_info():
    mem = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            mem[k] = int(v.split()[0]) * 1024
    st = os.statvfs("/")
    with open("/proc/uptime") as f:
        uptime = float(f.read().split()[0])
    load1, load5, load15 = os.getloadavg()
    return {
        "hostname": socket.gethostname(),
        "uptime_seconds": int(uptime),
        "booted_at": datetime.fromtimestamp(time.time() - uptime, timezone.utc).isoformat(timespec="seconds"),
        "cpus": os.cpu_count(),
        "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
        "memory": {
            "total": mem["MemTotal"],
            "available": mem["MemAvailable"],
            "used": mem["MemTotal"] - mem["MemAvailable"],
        },
        "swap": {"total": mem["SwapTotal"], "used": mem["SwapTotal"] - mem["SwapFree"]},
        "disk": {
            "total": st.f_blocks * st.f_frsize,
            "used": (st.f_blocks - st.f_bfree) * st.f_frsize,
            "free": st.f_bavail * st.f_frsize,
        },
    }


# --------------------------------------------------------------------------- systemd
def unit_info(unit):
    props = "ActiveState,SubState,NRestarts,MemoryCurrent,ExecMainStartTimestamp,MainPID,Description,Result"
    out = run(["systemctl", "show", unit, "-p", props])
    d = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    mem = d.get("MemoryCurrent", "")
    started = d.get("ExecMainStartTimestamp", "")
    started_epoch = None
    if started:
        # e.g. "Tue 2026-11-10 10:06:24 UTC"
        try:
            started_epoch = datetime.strptime(started, "%a %Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            pass
    return {
        "unit": unit,
        "description": d.get("Description", ""),
        "active": d.get("ActiveState", "unknown"),
        "sub": d.get("SubState", ""),
        "result": d.get("Result", ""),
        "restarts": int(d["NRestarts"]) if d.get("NRestarts", "").isdigit() else None,
        "memory": int(mem) if mem.isdigit() else None,
        "started_at": started,
        "uptime_seconds": int(time.time() - started_epoch) if started_epoch else None,
    }


def warnings_24h(unit):
    out = run(["journalctl", "-u", unit, "-p", "warning", "--since", "-24h", "--no-pager", "-q", "-o", "cat"], timeout=10)
    lines = [l for l in out.splitlines() if l.strip()]
    return {"count": len(lines), "last": lines[-1][:240] if lines else None}


# --------------------------------------------------------------------------- projects
def parse_conf(path):
    conf = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
            if not m:
                continue
            try:
                parts = shlex.split(m.group(2), comments=True)
                conf[m.group(1)] = parts[0] if parts else ""
            except ValueError:
                pass
    return conf


def http_health(url):
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=4) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception:
        code = None
    return {"code": code, "ms": int((time.monotonic() - t0) * 1000)}


def git_info(src):
    g = ["git", "-c", "safe.directory=*", "-C", src]
    sha = run(g + ["rev-parse", "--short=8", "HEAD"]).strip()
    log = run(g + ["log", "-1", "--format=%s%x1f%cI%x1f%an"]).strip().split("\x1f")
    branch = run(g + ["branch", "--show-current"]).strip() or "detached"
    return {
        "sha": sha or None,
        "branch": branch if sha else None,
        "subject": log[0] if len(log) == 3 else None,
        "committed_at": log[1] if len(log) == 3 else None,
        "author": log[2] if len(log) == 3 else None,
    }


def deploy_history(project, n=5):
    path = os.path.join(STATE_DIR, project, "history.log")
    try:
        with open(path) as f:
            lines = f.read().splitlines()[-n:]
    except OSError:
        return []
    out = []
    for l in reversed(lines):
        p = l.split()
        if len(p) >= 5:
            out.append({"at": p[0], "sha": p[1][:8], "ref": p[2], "status": p[3], "action": p[4]})
    return out


def projects():
    res = []
    for path in sorted(glob.glob(os.path.join(PIPELINE_DIR, "projects", "*.conf"))):
        name = os.path.basename(path)[:-5]
        if name.startswith("_"):
            continue
        c = parse_conf(path)
        svc = c.get("SERVICE", name)
        item = {
            "project": name,
            "service": svc,
            "domain": c.get("DOMAIN"),
            "db": c.get("DB_NAME"),
            "health_url": c.get("HEALTH_URL"),
            "unit": unit_info(svc),
            "health": http_health(c["HEALTH_URL"]) if c.get("HEALTH_URL") else None,
            "git": git_info(c["SOURCE_DIR"]) if c.get("SOURCE_DIR") else None,
            "deploys": deploy_history(name),
            "warnings_24h": warnings_24h(svc),
            "migrations": bool(c.get("MIGRATE_CMD")),
        }
        res.append(item)
    return res


# --------------------------------------------------------------------------- database
def psql(sql, db="postgres"):
    env = dict(os.environ, PGCONNECT_TIMEOUT="3")
    out = run(["psql", "-X", "-q", "-h", "127.0.0.1", "-U", PG_USER, "-d", db, "-w", "-tA", "-F", "\x1f", "-c", sql], env=env)
    return [line.split("\x1f") for line in out.splitlines() if line]


def database():
    v = psql("select version(), pg_postmaster_start_time(), current_setting('max_connections'), current_setting('shared_buffers')")
    if not v:
        return {"ok": False, "error": "cannot connect as %s (check PGPASSWORD / pg_hba)" % PG_USER}
    version, started, maxconn, shared = v[0]
    dbs = []
    for name, size, conns in psql(
        "select d.datname, pg_database_size(d.datname), "
        "(select count(*) from pg_stat_activity a where a.datname=d.datname) "
        "from pg_database d where not d.datistemplate order by 1"):
        info = {"name": name, "size": int(size), "connections": int(conns)}
        if name != "postgres":
            t = psql("select count(*), coalesce(sum(n_live_tup),0) from pg_stat_user_tables", db=name)
            if t:
                info["tables"], info["est_rows"] = int(t[0][0]), int(t[0][1])
            big = psql("select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc limit 3", db=name)
            info["largest"] = [{"table": r[0], "rows": int(r[1])} for r in big]
        dbs.append(info)
    states = {s or "background": int(c) for s, c in psql("select state, count(*) from pg_stat_activity group by 1")}
    return {
        "ok": True,
        "version": version.split(" on ")[0],
        "started_at": started,
        "max_connections": int(maxconn),
        "shared_buffers": shared,
        "connections_by_state": states,
        "databases": dbs,
    }


# --------------------------------------------------------------------------- tls
def cert_expiry(domain):
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection(("127.0.0.1", 443), timeout=4) as s:
            with ctx.wrap_socket(s, server_hostname=domain) as t:
                not_after = t.getpeercert()["notAfter"]
        exp = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        return {"domain": domain, "expires": exp.isoformat(), "days_left": (exp - datetime.now(timezone.utc)).days}
    except Exception as e:
        return {"domain": domain, "error": type(e).__name__}


# --------------------------------------------------------------------------- assemble
_cache = {"at": 0.0, "data": None}
_lock = threading.Lock()


def status():
    with _lock:
        if _cache["data"] and time.time() - _cache["at"] < CACHE_SECONDS:
            return _cache["data"]
        t0 = time.monotonic()
        projs = projects()
        domains = [p["domain"] for p in projs if p.get("domain")]
        data = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "host": host_info(),
            "projects": projs,
            "services": [unit_info(u) for u in EXTRA_UNITS],
            "database": database(),
            "certificates": [cert_expiry(d) for d in domains],
        }
        data["collect_ms"] = int((time.monotonic() - t0) * 1000)
        _cache.update(at=time.time(), data=data)
        return data


class Handler(BaseHTTPRequestHandler):
    server_version = "ops-dashboard"

    def _send(self, code, body, ctype):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._send(200, "ok\n", "text/plain")
        if path == "/api/status":
            try:
                return self._send(200, json.dumps(status()), "application/json")
            except Exception as e:  # never leak a traceback
                return self._send(500, json.dumps({"error": type(e).__name__}), "application/json")
        if path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        self._send(404, "not found\n", "text/plain")

    def log_message(self, fmt, *args):  # quiet: nginx already logs requests
        pass


if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print("ops-dashboard listening on http://%s:%d" % (BIND, PORT), flush=True)
    srv.serve_forever()
