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
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND = os.environ.get("OPS_BIND", "127.0.0.1")
PORT = int(os.environ.get("OPS_PORT", "9100"))
PIPELINE_DIR = os.environ.get("OPS_PIPELINE_DIR", "/opt/deploy")
STATE_DIR = os.environ.get("OPS_STATE_DIR", "/opt/deploy-state")
EXTRA_UNITS = os.environ.get("OPS_EXTRA_UNITS", "nginx postgresql amazon-ssm-agent certbot-renew.timer").split()
PG_USER = os.environ.get("PGUSER", "ops_monitor")
CACHE_SECONDS = 3
STOP_HOUR_UTC = int(os.environ.get("OPS_STOP_HOUR_UTC", "16"))   # EventBridge daily stop
START_HOUR_UTC = int(os.environ.get("OPS_START_HOUR_UTC", "4"))  # EventBridge daily start

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


# --------------------------------------------------------------------------- instance
_imds_cache = {}


def instance_meta():
    """EC2 instance metadata via IMDSv2 (cached: it never changes while running)."""
    if _imds_cache:
        return _imds_cache
    base = "http://169.254.169.254/latest"
    try:
        req = urllib.request.Request(base + "/api/token", method="PUT",
                                     headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"})
        token = urllib.request.urlopen(req, timeout=1).read().decode()
        doc = json.loads(urllib.request.urlopen(urllib.request.Request(
            base + "/dynamic/instance-identity/document", headers={"X-aws-ec2-metadata-token": token}), timeout=1).read())
        _imds_cache.update(instance_id=doc.get("instanceId"), instance_type=doc.get("instanceType"),
                           region=doc.get("region"), az=doc.get("availabilityZone"), image_id=doc.get("imageId"))
    except Exception:
        return {}
    return _imds_cache


def schedule():
    now = datetime.now(timezone.utc)
    stop = now.replace(hour=STOP_HOUR_UTC, minute=0, second=0, microsecond=0)
    if stop <= now:
        stop += timedelta(days=1)
    return {"stop_hour_utc": STOP_HOUR_UTC, "start_hour_utc": START_HOUR_UTC,
            "next_stop": stop.isoformat(timespec="seconds"), "seconds_to_stop": int((stop - now).total_seconds())}


# --------------------------------------------------------------------------- deployments
def live_deploy():
    """The pipeline's current.json, with a liveness check on the pipeline process."""
    try:
        with open(os.path.join(STATE_DIR, "current.json")) as f:
            cur = json.load(f)
    except (OSError, ValueError):
        return None
    alive = os.path.exists("/proc/%d" % int(cur.get("pid", 0)))
    cur["state"] = "running" if alive else "interrupted"
    for k in ("started_at", "step_started_at"):
        try:
            cur[k.replace("_at", "_elapsed_s")] = int(time.time() - datetime.strptime(
                cur[k], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
        except (KeyError, ValueError):
            pass
    return cur


def deploy_events(limit=200):
    path = os.path.join(STATE_DIR, "deployments.jsonl")
    try:
        with open(path) as f:
            lines = f.readlines()[-limit:]
    except OSError:
        return []
    out = []
    for l in lines:
        try:
            out.append(json.loads(l))
        except ValueError:
            pass
    return list(reversed(out))   # newest first


def deploy_summary(events, project):
    mine = [e for e in events if e.get("project") == project]
    week_ago = time.time() - 7 * 86400

    def ts(e):
        try:
            return datetime.strptime(e["finished_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        except (KeyError, ValueError):
            return 0
    week = [e for e in mine if ts(e) >= week_ago and e.get("action") == "deploy"]
    ok = [e for e in week if e.get("status") == "success"]
    last_ok = next((e for e in mine if e.get("action") in ("deploy", "rollback", "restore") and e.get("status") == "success"), None)
    durations = sorted(e.get("duration_s", 0) for e in mine if e.get("action") == "deploy" and e.get("status") == "success")
    return {
        "last": mine[0] if mine else None,
        "last_success": last_ok,
        "deploys_7d": len(week),
        "success_rate_7d": round(len(ok) / len(week) * 100) if week else None,
        "median_duration_s": durations[len(durations) // 2] if durations else None,
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
    out = run(["journalctl", "-u", unit, "--since", "-24h", "--no-pager", "-q", "-o", "json",
               "--output-fields=MESSAGE,PRIORITY"], timeout=10)
    hits, errors = [], 0
    for line in out.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        msg = j.get("MESSAGE", "")
        if isinstance(msg, list):
            msg = bytes(msg).decode(errors="replace")
        lvl = effective_level(int(j.get("PRIORITY", 6)), msg)
        if lvl <= 4:
            hits.append(msg)
            errors += lvl <= 3
    return {"count": len(hits), "errors": errors, "last": hits[-1][:240] if hits else None}


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


def projects(events):
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
            "deploy_summary": deploy_summary(events, name),
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
            t = psql("select count(*), coalesce(sum(n_live_tup),0), "
                     "count(*) filter (where n_live_tup = 0 and last_analyze is null and last_autoanalyze is null) "
                     "from pg_stat_user_tables", db=name)
            if t:
                info["tables"], info["est_rows"], info["unanalyzed_tables"] = int(t[0][0]), int(t[0][1]), int(t[0][2])
            big = psql("select relname, n_live_tup from pg_stat_user_tables "
                       "order by n_live_tup desc, pg_total_relation_size(relid) desc limit 3", db=name)
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


# --------------------------------------------------------------------------- per-app detail
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAFE_ENV_VALUES = {"PORT", "NODE_ENV"}          # everything else: names only (units may still hold secrets)
SINCE = {"15m": "-15min", "1h": "-1h", "6h": "-6h", "24h": "-24h", "7d": "-7d", "boot": None}


def load_project(name):
    if not NAME_RE.match(name or ""):
        return None
    path = os.path.join(PIPELINE_DIR, "projects", name + ".conf")
    return parse_conf(path) if os.path.isfile(path) else None


def unit_detail(unit):
    props = ("ActiveState,SubState,Result,NRestarts,MemoryCurrent,TasksCurrent,CPUUsageNSec,"
             "ExecMainStartTimestamp,MainPID,FragmentPath,WorkingDirectory,User,UnitFileState,Environment,"
             "Requires,Description")
    out = run(["systemctl", "show", unit, "-p", props])
    d = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    env = []
    for tok in shlex.split(d.get("Environment", "")) if d.get("Environment") else []:
        k = tok.split("=", 1)[0]
        env.append({"name": k, "value": tok.split("=", 1)[1] if k in SAFE_ENV_VALUES and "=" in tok else None})
    num = lambda k: int(d[k]) if d.get(k, "").isdigit() else None
    base = unit_info(unit)
    base.update({
        "main_pid": num("MainPID"), "tasks": num("TasksCurrent"),
        "cpu_seconds": round(num("CPUUsageNSec") / 1e9, 1) if num("CPUUsageNSec") is not None else None,
        "unit_file": d.get("FragmentPath"), "working_dir": d.get("WorkingDirectory"), "user": d.get("User"),
        "enabled": d.get("UnitFileState"), "requires": [r for r in d.get("Requires", "").split() if r],
        "env": env,
    })
    return base


def health_detail(url):
    t0 = time.monotonic()
    info = {"url": url, "code": None, "ms": None, "body": None, "content_type": None}
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            info["code"], info["content_type"] = r.status, r.headers.get("Content-Type")
            body = r.read(4096).decode(errors="replace")
    except urllib.error.HTTPError as e:
        info["code"], body = e.code, e.read(2048).decode(errors="replace")
    except Exception as e:
        body = type(e).__name__
    info["ms"] = int((time.monotonic() - t0) * 1000)
    try:
        info["body"] = json.dumps(json.loads(body), indent=2)[:3000]
    except ValueError:
        info["body"] = body[:1500]
    return info


def git_detail(src, branch):
    g = ["git", "-c", "safe.directory=*", "-C", src]
    commits = []
    for line in run(g + ["log", "-15", "--format=%H%x1f%s%x1f%an%x1f%cI"]).splitlines():
        p = line.split("\x1f")
        if len(p) == 4:
            commits.append({"sha": p[0][:8], "subject": p[1], "author": p[2], "date": p[3]})
    behind = run(g + ["rev-list", "--count", "HEAD..origin/%s" % branch]).strip()
    upstream = []
    for line in run(g + ["log", "-10", "--format=%H%x1f%s%x1f%an%x1f%cI", "HEAD..origin/%s" % branch]).splitlines():
        p = line.split("\x1f")
        if len(p) == 4:
            upstream.append({"sha": p[0][:8], "subject": p[1], "author": p[2], "date": p[3]})
    dirty = [l[3:] for l in run(g + ["status", "--porcelain", "--untracked-files=no"]).splitlines()]
    fetched = None
    try:
        ref = os.path.join(src, ".git", "FETCH_HEAD")
        if not os.path.exists(ref):
            ref = os.path.join(src, ".git", "refs", "remotes", "origin", branch)
        fetched = datetime.fromtimestamp(os.path.getmtime(ref), timezone.utc).isoformat(timespec="seconds")
    except OSError:
        pass
    info = git_info(src)
    info.update({"commits": commits, "behind": int(behind) if behind.isdigit() else None,
                 "upstream_commits": upstream, "tracking": "origin/" + branch, "dirty_files": dirty[:30],
                 "last_fetch": fetched})
    return info


def db_detail(dbname):
    if not dbname:
        return None
    size = psql("select pg_database_size(current_database())", db=dbname)
    if not size:
        return {"ok": False, "error": "cannot connect to %s as %s" % (dbname, PG_USER)}
    tables = []
    for r in psql(
            "select schemaname||'.'||relname, n_live_tup, n_dead_tup, pg_total_relation_size(relid), "
            "pg_indexes_size(relid), coalesce(seq_scan,0), coalesce(idx_scan,0), n_tup_ins, n_tup_upd, n_tup_del, "
            "greatest(last_autovacuum,last_vacuum), coalesce(greatest(last_autoanalyze,last_analyze)::text,'') "
            "from pg_stat_user_tables order by pg_total_relation_size(relid) desc", db=dbname):
        analyzed = bool(r[11])
        tables.append({"table": r[0], "rows": int(r[1]) if (analyzed or int(r[1]) > 0) else None, "dead": int(r[2]), "size": int(r[3]), "index_size": int(r[4]),
                       "seq_scans": int(r[5]), "idx_scans": int(r[6]), "inserts": int(r[7]), "updates": int(r[8]),
                       "deletes": int(r[9]), "last_vacuum": r[10] or None, "last_analyze": r[11] or None,
                       "analyzed": analyzed})
    conns = [{"state": r[0] or "idle", "user": r[1], "app": r[2], "since": r[3] or None, "wait": r[4] or None}
             for r in psql("select state, usename, application_name, coalesce(state_change::text,''), "
                           "coalesce(wait_event_type||':'||wait_event,'') from pg_stat_activity "
                           "where datname = current_database() and pid <> pg_backend_pid()", db=dbname)]
    migr = next((t for t in tables if re.search(r"(__drizzle_migrations|_prisma_migrations)$", t["table"])), None)
    stats_reset = psql("select coalesce(stats_reset::text,'') from pg_stat_database where datname = current_database()", db=dbname)
    return {"ok": True, "name": dbname, "size": int(size[0][0]), "tables": tables, "connections": conns,
            "stats_reset": (stats_reset[0][0] or None) if stats_reset else None,
            "migrations_applied": migr["rows"] if migr else None,
            "migrations_table": migr["table"] if migr else None}


def app_detail(name):
    c = load_project(name)
    if c is None:
        return None
    svc = c.get("SERVICE", name)
    events = [e for e in deploy_events(1000) if e.get("project") == name]
    cur = live_deploy()
    return {
        "project": name, "service": svc, "domain": c.get("DOMAIN"), "branch": c.get("BRANCH", "main"),
        "config": {k: c.get(k) for k in ("SOURCE_DIR", "APP_SUBDIR", "RUN_DIR", "INSTALL_CMD", "BUILD_CMD",
                                         "MIGRATE_CMD", "HEALTH_URL", "HEALTH_TIMEOUT", "DB_NAME") if c.get(k)},
        "deploying": cur if cur and cur.get("project") == name else None,
        "unit": unit_detail(svc),
        "health": health_detail(c["HEALTH_URL"]) if c.get("HEALTH_URL") else None,
        "git": git_detail(c["SOURCE_DIR"], c.get("BRANCH", "main")) if c.get("SOURCE_DIR") else None,
        "deploys": events[:100],
        "deploy_summary": deploy_summary(events, name),
        "warnings_24h": warnings_24h(svc),
        "database": db_detail(c.get("DB_NAME")),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def app_logs(name, qs):
    c = load_project(name)
    if c is None:
        return None
    svc = c.get("SERVICE", name)
    def arg(k, default):
        v = qs.get(k, [default])[0]
        return v if v is not None else default
    try:
        lines = max(20, min(2000, int(arg("lines", "200"))))
        prio = max(0, min(7, int(arg("priority", "7"))))
    except ValueError:
        lines, prio = 200, 7
    since = SINCE.get(arg("since", "24h"), "-24h")
    q = (arg("q", "") or "")[:100].lower()
    # fetch all priorities and filter on the *effective* level ourselves
    cmd = ["journalctl", "-u", svc, "-o", "json", "--no-pager", "-q",
           "-n", str(min(lines * 5, 10000) if (q or prio < 7) else lines)]
    cmd += ["--since", since] if since else ["-b"]
    out = run(cmd, timeout=15)
    entries = []
    for line in out.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        msg = j.get("MESSAGE", "")
        if isinstance(msg, list):  # binary/non-UTF8 messages arrive as byte arrays
            msg = bytes(msg).decode(errors="replace")
        msg = ANSI_RE.sub("", msg)
        if q and q not in msg.lower():
            continue
        raw = int(j.get("PRIORITY", 6))
        level = effective_level(raw, msg)
        if level > prio:
            continue
        entries.append({"ts": int(j.get("__REALTIME_TIMESTAMP", "0")) // 1000, "priority": level, "journal_priority": raw,
                        "source": j.get("SYSLOG_IDENTIFIER") or j.get("_COMM") or "", "pid": j.get("_PID"),
                        "message": msg[:4000]})
    entries = entries[-lines:]
    counts = {}
    for e in entries:
        counts[e["priority"]] = counts.get(e["priority"], 0) + 1
    return {"project": name, "service": svc, "entries": entries, "count": len(entries), "by_priority": counts,
            "query": {"lines": lines, "priority": prio, "since": arg("since", "24h"), "q": q},
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
ERR_RE = re.compile(r"\b(error|exception|fatal|failed|unhandled|ECONNREFUSED|ETIMEDOUT|panic)\b", re.I)
WARN_RE = re.compile(r"\b(warn(ing)?|deprecat\w*|MaxListenersExceeded\w*)\b", re.I)


def effective_level(priority, msg):
    """journald stores an app's stdout/stderr as INFO; infer a level from the text so filters work."""
    if priority <= 4:
        return priority
    if ERR_RE.search(msg):
        return 3
    if WARN_RE.search(msg):
        return 4
    return priority


# --------------------------------------------------------------------------- assemble
_cache = {"at": 0.0, "data": None}
_lock = threading.Lock()


def status(fresh=False):
    with _lock:
        max_age = 1 if fresh else CACHE_SECONDS   # "fresh" still rate-limited to 1/s
        if _cache["data"] and time.time() - _cache["at"] < max_age:
            return _cache["data"]
        t0 = time.monotonic()
        events = deploy_events()
        projs = projects(events)
        domains = [p["domain"] for p in projs if p.get("domain")]
        data = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "deploying": live_deploy(),
            "deploy_events": events[:25],
            "instance": instance_meta(),
            "schedule": schedule(),
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

    def _json(self, fn):
        try:
            data = fn()
        except Exception as e:  # never leak a traceback
            return self._send(500, json.dumps({"error": type(e).__name__}), "application/json")
        if data is None:
            return self._send(404, json.dumps({"error": "unknown project"}), "application/json")
        return self._send(200, json.dumps(data), "application/json")

    def do_GET(self):
        path, _, query = self.path.partition("?")
        qs = urllib.parse.parse_qs(query)
        if path == "/healthz":
            return self._send(200, "ok\n", "text/plain")
        if path == "/api/status":
            return self._json(lambda: status(fresh="fresh" in qs))
        m = re.match(r"^/api/app/([A-Za-z0-9_-]{1,64})(/logs)?$", path)
        if m:
            name = m.group(1)
            return self._json(lambda: app_logs(name, qs) if m.group(2) else app_detail(name))
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
