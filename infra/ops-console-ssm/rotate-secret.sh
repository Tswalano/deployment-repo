#!/bin/bash
# OpsConsole-RotateSecret: rotate or reload one app's secrets ON the instance, with automatic restore.
#   kind=db-password target=<postgres role>  new password for a role used by the apps' DATABASE_URLs:
#        SSM values (DATABASE_URL / DATABASE_PASSWORD of every app using that role) → ALTER ROLE → ~ec2-user/.pgpass
#        → restart every affected app → health checks. Any failure restores the old values, password and .pgpass.
#   kind=jwt         target=<service>      new JWT_SECRET for one app (signs everyone out of it) → restart → health
#   kind=reload      target=<service>      re-read SSM (after a value was changed in the console) → restart → health
# New values are generated here and go straight to SSM: they never appear in the command, its output or any log.
# Output: one JSON line (names of parameters changed, services restarted, health codes; never values).
set -u
export LC_ALL=C
KIND='{{ kind }}'
TARGET='{{ target }}'
case "$KIND" in db-password|jwt|reload) ;; *) echo '{"ok":false,"error":"unknown kind"}'; exit 2 ;; esac
[[ "$TARGET" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || { echo '{"ok":false,"error":"invalid target"}'; exit 2; }
exec python3 -I - "$KIND" "$TARGET" <<'PY'
import json, os, re, secrets, subprocess, sys, time, urllib.request
kind, target = sys.argv[1], sys.argv[2]
out = {"ok": False, "kind": kind, "target": target, "updated": [], "restarted": [], "health": {}, "restored": False}
def done(**kw):
    out.update(kw); print(json.dumps(out)); sys.exit(0 if out["ok"] else 1)

def imds(path):
    tok = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT",
          headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}), timeout=2).read().decode()
    return urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/meta-data/" + path,
          headers={"X-aws-ec2-metadata-token": tok}), timeout=2).read().decode()
REGION = imds("placement/region")
def aws(*a):
    return subprocess.run(["aws", *a, "--region", REGION, "--output", "json"], capture_output=True, text=True, check=True).stdout
def put(name, value):   # value via --cli-input-json on stdin: never on a command line
    subprocess.run(["aws", "ssm", "put-parameter", "--region", REGION, "--cli-input-json", "file:///dev/stdin"],
                   input=json.dumps({"Name": name, "Value": value, "Type": "SecureString", "Overwrite": True}),
                   capture_output=True, text=True, check=True)

# projects on this instance: SERVICE and HEALTH_URL from /opt/deploy/projects/*.conf
apps = {}
for f in sorted(os.listdir("/opt/deploy/projects")):
    if not f.endswith(".conf") or f.startswith("_"): continue
    conf = dict(re.findall(r'^([A-Z_]+)="([^"]*)"', open("/opt/deploy/projects/" + f).read(), re.M))
    if conf.get("SERVICE"): apps[conf["SERVICE"]] = conf.get("HEALTH_URL")
params = {p["Name"]: p["Value"] for p in json.loads(aws("ssm", "get-parameters-by-path", "--path", "/apps", "--recursive", "--with-decryption"))["Parameters"]}

def health(svc):
    url = apps.get(svc)
    if not url: return 0
    for _ in range(45):
        try:
            code = urllib.request.urlopen(url, timeout=3).status
            if 200 <= code < 300: return code
        except urllib.error.HTTPError as e: code = e.code
        except Exception: code = 0
        time.sleep(2)
    return code
def restart(svcs):
    for s in svcs:
        subprocess.run(["systemctl", "restart", f"app-secrets@{s}"], check=True)
        subprocess.run(["systemctl", "restart", s], check=True)
    return {s: health(s) for s in svcs}

def psql_as_ec2user(sql):
    subprocess.run(["runuser", "-u", "ec2-user", "--", "env", "-i", "HOME=/home/ec2-user", "PATH=/usr/bin:/bin",
                    "psql", "-X", "-q", "-h", "localhost", "-U", "postgres", "-w", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
                   input=sql, capture_output=True, text=True, check=True)
def quote_ident(x): return '"' + x.replace('"', '""') + '"'
def quote_lit(x): return "'" + x.replace("'", "''") + "'"
PGPASS = "/home/ec2-user/.pgpass"
def pgpass_set(role, pw):
    if not os.path.exists(PGPASS): return None
    old = open(PGPASS).read()
    lines = [(":".join(l.split(":")[:4] + [pw]) if len(l.split(":")) >= 5 and l.split(":")[3] == role else l) for l in old.splitlines()]
    open(PGPASS, "w").write("\n".join(lines) + "\n"); os.chmod(PGPASS, 0o600)
    return old
def url_user(url):
    m = re.match(r"^[a-z]+://([^:/@]+):", url or ""); return m.group(1) if m else None
def url_with_pw(url, user, pw):
    scheme, rest = url.split("://", 1); _, host = rest.rsplit("@", 1)
    return f"{scheme}://{user}:{pw}@{host}"

snapshot, pg_old, role_old_pw = {}, None, None
try:
    if kind == "reload":
        if target not in apps: done(error=f"unknown service {target}")
        h = restart([target]); out["restarted"] = [target]; out["health"] = h
        done(ok=all(200 <= c < 300 for c in h.values()) or not apps.get(target))

    if kind == "jwt":
        name = f"/apps/{target}/JWT_SECRET"
        if target not in apps or name not in params: done(error=f"{target} has no JWT_SECRET")
        snapshot[name] = params[name]
        put(name, secrets.token_urlsafe(48)); out["updated"] = [name]
        h = restart([target]); out["restarted"] = [target]; out["health"] = h
        if not all(200 <= c < 300 for c in h.values()): raise RuntimeError(f"{target} unhealthy after rotation")
        done(ok=True)

    # db-password
    role = target
    if role in ("opsconsole", "ops_monitor"): done(error="that role belongs to the console, not an app")
    urls = {n: v for n, v in params.items() if n.endswith("/DATABASE_URL") and n.split("/")[2] in apps and url_user(v) == role}
    pws = {n: v for n, v in params.items() if n.endswith("/DATABASE_PASSWORD") and n.split("/")[2] in apps
           and params.get(n.rsplit("/", 1)[0] + "/DATABASE_USER") == role}
    if not urls and not pws: done(error=f"no app uses the database role {role}")
    affected = sorted({n.split("/")[2] for n in list(urls) + list(pws)})
    role_old_pw = next((re.match(r"^[a-z]+://[^:]+:(.*)@[^@]+$", v).group(1) for v in urls.values()), None) or next(iter(pws.values()))
    new = "".join(c if c.isalnum() else "x" for c in secrets.token_urlsafe(32))
    snapshot = {**urls, **pws}
    for n, v in urls.items(): put(n, url_with_pw(v, role, new))
    for n in pws: put(n, new)
    out["updated"] = sorted(snapshot)
    psql_as_ec2user(f"ALTER ROLE {quote_ident(role)} WITH PASSWORD {quote_lit(new)};\n")
    pg_old = pgpass_set(role, new)
    h = restart(affected); out["restarted"] = affected; out["health"] = h
    if not all(200 <= c < 300 for c in h.values()): raise RuntimeError("an app is unhealthy after rotation: " + ", ".join(f"{s}={c}" for s, c in h.items()))
    done(ok=True)
except SystemExit:
    raise
except Exception as e:
    err = str(e) if not isinstance(e, subprocess.CalledProcessError) else f"{e.cmd[0]} {e.cmd[1] if len(e.cmd) > 1 else ''} failed: {(e.stderr or '')[:200]}"
    # restore: SSM values, role password, .pgpass, then restart what we touched
    try:
        for n, v in snapshot.items(): put(n, v)
        if kind == "db-password" and role_old_pw:
            psql_as_ec2user(f"ALTER ROLE {quote_ident(target)} WITH PASSWORD {quote_lit(role_old_pw)};\n")
        if pg_old is not None:
            open(PGPASS, "w").write(pg_old); os.chmod(PGPASS, 0o600)
        if out["restarted"] or snapshot:
            out["health_after_restore"] = restart(out["restarted"] or sorted({n.split('/')[2] for n in snapshot}))
        out["restored"] = bool(snapshot)
    except Exception as e2:
        err += f" | RESTORE FAILED: {str(e2)[:200]}"
    done(ok=False, error=err.replace(new if 'new' in dir() else '\0', '[redacted]')[:500])
PY
