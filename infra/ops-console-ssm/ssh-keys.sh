#!/bin/bash
# OpsConsole-SshKeys: add or remove one public key in a login user's ~/.ssh/authorized_keys.
#   action=add    user=<login user> key=<one public key line>
#   action=remove user=<login user> fingerprint=SHA256:...
# Only normal login users (uid >= 1000, a login shell and a home): never root. Refuses to remove ec2-user's last
# key (SSH lock-out). Keeps a copy of the previous file as authorized_keys.ops-console.bak.
# Output: one JSON line.
set -u
export LC_ALL=C
ACTION='{{ action }}'
KUSER='{{ user }}'
KEY='{{ key }}'
FP='{{ fingerprint }}'
case "$ACTION" in add|remove) ;; *) echo '{"ok":false,"error":"unknown action"}'; exit 2 ;; esac
[[ "$KUSER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo '{"ok":false,"error":"invalid user"}'; exit 2; }
exec python3 -I - "$ACTION" "$KUSER" "$KEY" "$FP" <<'PY'
import json, os, pwd, re, shutil, subprocess, sys, tempfile
action, user, key, fp = sys.argv[1:5]
def done(ok, **kw):
    print(json.dumps({"ok": ok, "action": action, "user": user, **kw})); sys.exit(0 if ok else 1)

KEY_RE = re.compile(r"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{40,2000}={0,3}( [A-Za-z0-9@._+-]{1,100})?$")
FP_RE = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")
TYPES = ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
         "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com", "ssh-dss")

try:
    pw = pwd.getpwnam(user)
except KeyError:
    done(False, error=f"there is no user {user} on this instance")
if pw.pw_uid < 1000 or pw.pw_shell.endswith(("nologin", "false")) or not os.path.isdir(pw.pw_dir):
    done(False, error=f"{user} is not a normal login user")

def fingerprint_of(line):
    parts = line.split()
    for i, p in enumerate(parts):
        if p in TYPES and i + 1 < len(parts):
            r = subprocess.run(["ssh-keygen", "-lf", "-"], input=f"{p} {parts[i + 1]}\n", capture_output=True, text=True, timeout=10)
            m = re.match(r"^\d+ (SHA256:\S+)", r.stdout.strip())
            return m.group(1) if m else None
    return None

sshdir = os.path.join(pw.pw_dir, ".ssh")
path = os.path.join(sshdir, "authorized_keys")
try:
    lines = open(path).read().splitlines()
except FileNotFoundError:
    lines = []

def write(new_lines):
    if not os.path.isdir(sshdir):
        os.mkdir(sshdir, 0o700); os.chown(sshdir, pw.pw_uid, pw.pw_gid)
    if os.path.exists(path):
        shutil.copy2(path, path + ".ops-console.bak"); os.chown(path + ".ops-console.bak", pw.pw_uid, pw.pw_gid)
    fd, tmp = tempfile.mkstemp(dir=sshdir, prefix=".authorized_keys.")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(new_lines) + ("\n" if new_lines else ""))
    os.chmod(tmp, 0o600); os.chown(tmp, pw.pw_uid, pw.pw_gid)
    os.replace(tmp, path)
    if shutil.which("restorecon"): subprocess.run(["restorecon", "-R", sshdir], capture_output=True)

keyed = [(l, fingerprint_of(l)) for l in lines]
count = sum(1 for _, f in keyed if f)

if action == "add":
    if not KEY_RE.match(key): done(False, error="that doesn't look like a single OpenSSH public key line")
    new_fp = fingerprint_of(key)
    if not new_fp: done(False, error="ssh-keygen could not read that key")
    if any(f == new_fp for _, f in keyed): done(False, error=f"{user} already has this key", fingerprint=new_fp)
    write(lines + [key])
    done(True, fingerprint=new_fp, keys=count + 1)

if not FP_RE.match(fp): done(False, error="invalid fingerprint")
keep = [l for l, f in keyed if f != fp]
if len(keep) == len(lines): done(False, error=f"{user} has no key with fingerprint {fp}")
removed = len(lines) - len(keep)
if user == "ec2-user" and count - removed < 1:
    done(False, error="that is ec2-user's last key: removing it would lock everyone out of SSH. Add another key first.")
write(keep)
done(True, fingerprint=fp, keys=count - removed)
PY
