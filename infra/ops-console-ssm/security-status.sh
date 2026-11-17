#!/bin/bash
# OpsConsole-Security: read-only security snapshot of this instance. No parameters.
#   - who can log in: authorized_keys of every login user (type, fingerprint, comment; never the key itself)
#   - SSH logins of the last 7 days (from the sshd journal, with the key fingerprint used) and failed attempts
#   - who is logged in now, the effective sshd settings
#   - OS updates: on Amazon Linux 2023, newer releases (that is how AL2023 ships fixes); elsewhere, pending
#     security advisories; and whether a reboot is needed
# Uses only cheap package queries: never `dnf --releasever=latest updateinfo` (≈0.5 GB of memory on small boxes).
# Output: base64(gzip(JSON)).
set -u
export LC_ALL=C
exec nice -n 10 python3 -I - <<'PY'
import base64, gzip, json, os, pwd, re, subprocess, time

def run(cmd, timeout=90, stdin=None):
    try:
        p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except Exception as e:
        return -1, "", str(e)

out = {"at": int(time.time())}

# ---------------------------------------------------------------- OS
osr = {}
try:
    for line in open("/etc/os-release"):
        k, _, v = line.strip().partition("=")
        osr[k] = v.strip('"')
except Exception:
    pass
rc, rel, _ = run(["rpm", "-q", "--qf", "%{VERSION}", "system-release"], 10)
out["os"] = {"name": osr.get("PRETTY_NAME"), "id": osr.get("ID"), "version": osr.get("VERSION_ID"),
             "release": rel.strip() if rc == 0 else None, "kernel": os.uname().release}

# ---------------------------------------------------------------- updates
def release_date(v):
    m = re.search(r"\.(\d{8})$", v or "")
    return f"{m.group(1)[:4]}-{m.group(1)[4:6]}-{m.group(1)[6:]}" if m else None

upd = {"kind": None, "current": None, "currentDate": None, "newer": [], "advisories": [], "advisoryCount": 0,
       "severities": {}, "command": None, "error": None}
al2023 = osr.get("ID") == "amzn" and (osr.get("VERSION_ID") or "").startswith("2023")
if al2023:
    upd["kind"] = "release"
    upd["current"] = out["os"]["release"]; upd["currentDate"] = release_date(upd["current"])
    rc, so, se = run(["dnf", "check-release-update"], 90)
    vers = sorted(set(re.findall(r"Version (2023\.\d+\.\d{8}):", so + se)))
    upd["newer"] = [{"version": v, "date": release_date(v)} for v in vers]
    if rc not in (0, 100) and not vers: upd["error"] = (se or so).strip()[-300:] or f"dnf exited {rc}"
    if vers: upd["command"] = f"sudo dnf upgrade --releasever={vers[-1]}"
# security advisories in the enabled repos (the real answer on AL2/RHEL-likes; usually empty on a locked AL2023 release)
if os.path.exists("/usr/bin/dnf") or os.path.exists("/usr/bin/yum"):
    tool = "dnf" if os.path.exists("/usr/bin/dnf") else "yum"
    rc, so, se = run([tool, "-q", "updateinfo", "list", "--security"] if tool == "dnf" else ["yum", "-q", "updateinfo", "list", "security"], 120)
    if rc == 0:
        seen = set()
        for line in so.splitlines():
            m = re.match(r"^(\S+)\s+(\S+?)(?:/Sec\.)?\s+(\S+)$", line.strip())
            if not m: continue
            adv, sev, pkg = m.groups()
            sev = sev.split("/")[0]
            upd["severities"][sev] = upd["severities"].get(sev, 0) + 1
            if (adv, pkg) not in seen and len(upd["advisories"]) < 60:
                seen.add((adv, pkg)); upd["advisories"].append({"id": adv, "severity": sev, "package": pkg})
        upd["advisoryCount"] = sum(upd["severities"].values())
        if not upd["kind"]: upd["kind"] = "advisories"
        if upd["advisoryCount"] and not upd["command"]: upd["command"] = f"sudo {tool} upgrade --security"
    elif not upd["error"] and not al2023:
        upd["error"] = (se or so).strip()[-300:] or f"{tool} exited {rc}"
rc, so, _ = run(["needs-restarting", "-r"], 60)
upd["rebootRequired"] = True if rc == 1 else False if rc == 0 else None
rc, so, _ = run(["rpm", "-q", "--last", "kernel"], 10)
newest_kernel = so.split()[0].replace("kernel-", "", 1) if rc == 0 and so.strip() else None
upd["newestKernel"] = newest_kernel
upd["kernelPending"] = bool(newest_kernel and newest_kernel != os.uname().release)
out["updates"] = upd

# ---------------------------------------------------------------- sshd settings
rc, so, _ = run(["sshd", "-T"], 10)
cfg = {}
for line in so.splitlines():
    k, _, v = line.partition(" ")
    if k in ("port", "permitrootlogin", "passwordauthentication", "pubkeyauthentication", "kbdinteractiveauthentication", "maxauthtries", "x11forwarding"):
        cfg[k] = v.strip()
out["sshd"] = cfg

# ---------------------------------------------------------------- host keys (to verify a first SSH connection)
host_keys = []
for f in sorted(os.listdir("/etc/ssh")) if os.path.isdir("/etc/ssh") else []:
    if f.startswith("ssh_host_") and f.endswith("_key.pub"):
        rc, so, _ = run(["ssh-keygen", "-lf", os.path.join("/etc/ssh", f)], 10)
        m = re.match(r"^\d+ (SHA256:\S+) .*\((\w+)\)$", so.strip())
        if m: host_keys.append({"type": m.group(2), "fingerprint": m.group(1)})
out["hostKeys"] = host_keys

# ---------------------------------------------------------------- authorized keys of every login user
TYPES = ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
         "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com", "ssh-dss")
def split_key(line):
    """(options, type, blob, comment) of an authorized_keys line, or None."""
    parts = line.split()
    for i, p in enumerate(parts):
        if p in TYPES and i + 1 < len(parts):
            return " ".join(parts[:i]), p, parts[i + 1], " ".join(parts[i + 2:])
    return None
def fingerprint(typ, blob):
    rc, so, _ = run(["ssh-keygen", "-lf", "-"], 10, f"{typ} {blob}\n")
    m = re.match(r"^(\d+) (SHA256:\S+)", so.strip())
    return (m.group(2), int(m.group(1))) if m else (None, None)

users = []
for pw in pwd.getpwall():
    if pw.pw_shell.endswith(("nologin", "false", "sync", "shutdown", "halt")): continue
    if not (pw.pw_uid == 0 or pw.pw_uid >= 1000) or not os.path.isdir(pw.pw_dir): continue
    path = os.path.join(pw.pw_dir, ".ssh", "authorized_keys")
    keys = []
    try:
        lines = open(path).read().splitlines()
    except FileNotFoundError:
        lines = []
    except Exception as e:
        lines = []; keys.append({"error": str(e)[:120]})
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"): continue
        k = split_key(line)
        if not k: continue
        opts, typ, blob, comment = k
        fp, bits = fingerprint(typ, blob)
        exp = re.search(r'expiry-time="(\d{8,14})', opts)
        src = re.search(r'from="([^"]*)"', opts)
        expires = None
        if exp:
            try: expires = int(time.mktime(time.strptime(exp.group(1)[:12].ljust(12, "0"), "%Y%m%d%H%M")))
            except Exception: expires = None
        keys.append({"type": typ, "bits": bits, "fingerprint": fp, "comment": comment[:100],
                     "options": bool(opts), "blocked": "command=" in opts, "expires": expires, "from": src.group(1)[:200] if src else None})
    users.append({"user": pw.pw_name, "uid": pw.pw_uid, "home": pw.pw_dir, "keys": keys,
                  "manageable": pw.pw_uid != 0 and (pw.pw_uid >= 1000)})
out["users"] = users

# ---------------------------------------------------------------- SSH logins (journal, 7 days)
rc, so, _ = run(["journalctl", "-u", "sshd", "--since", "-7 days", "-n", "20000", "-o", "json", "--no-pager", "-q",
                 "--output-fields=MESSAGE,__REALTIME_TIMESTAMP"], 60)
accepted, fails = [], {}
now = time.time()
ACC = re.compile(r"^Accepted (\S+) for (\S+) from (\S+) port \d+ \S+(?:: (\S+) (\S+))?")
FAIL = [re.compile(r"^Invalid user (\S*) from (\S+)"),
        re.compile(r"^Failed \S+ for (?:invalid user )?(\S+) from (\S+)"),
        re.compile(r"^Connection closed by authenticating user (\S+) (\S+)"),
        re.compile(r"^Disconnected from authenticating user (\S+) (\S+)")]
for line in so.splitlines():
    try:
        e = json.loads(line)
    except Exception:
        continue
    msg = e.get("MESSAGE")
    if not isinstance(msg, str): continue
    ts = int(e.get("__REALTIME_TIMESTAMP", "0")) / 1e6
    m = ACC.match(msg)
    if m:
        method, user, ip, ktype, fp = m.groups()
        accepted.append({"at": int(ts), "user": user, "ip": ip, "method": method, "keyType": ktype, "fingerprint": fp})
        continue
    for r in FAIL:
        m = r.match(msg)
        if m:
            user, ip = m.groups()
            f = fails.setdefault(ip, {"ip": ip, "count": 0, "count24h": 0, "last": 0, "users": []})
            f["count"] += 1
            if now - ts < 86400: f["count24h"] += 1
            f["last"] = max(f["last"], int(ts))
            if user and user not in f["users"] and len(f["users"]) < 5: f["users"].append(user[:32])
            break
accepted.sort(key=lambda x: -x["at"])
top = sorted(fails.values(), key=lambda x: -x["count"])
out["logins"] = {"accepted": accepted[:50], "acceptedTotal": len(accepted),
                 "failed": top[:15], "failedTotal": sum(f["count"] for f in top), "failed24h": sum(f["count24h"] for f in top),
                 "failedIps": len(top), "journal": rc == 0}

# ---------------------------------------------------------------- logged in now
rc, so, _ = run(["who", "--ips"], 10)
now_on = []
for line in so.splitlines():
    p = line.split()
    if len(p) >= 4:
        now_on.append({"user": p[0], "tty": p[1], "since": f"{p[2]} {p[3]}", "from": p[4] if len(p) > 4 else None})
out["sessions"] = now_on

print(base64.b64encode(gzip.compress(json.dumps(out, separators=(",", ":")).encode(), 9)).decode(), end="")
PY
