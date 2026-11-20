#!/bin/bash
# OpsConsole-Components: what runs on the server besides the apps, and installing/starting/stopping/removing it.
# Amazon Linux 2023 packages only (no third-party repositories); versions offered are whatever the OS repositories have.
#   list                         installed components, versions, running state, memory, and what can be installed
#   install <component> [ver]    postgresql (one version per server), mariadb, valkey, sqlite, python (several versions)
#   start|stop <component>       postgresql, mariadb, valkey (PostgreSQL is never stopped on the console's own server)
#   remove <component> [ver]     valkey, sqlite, python <ver>, mariadb (only without databases of its own);
#                                never PostgreSQL; data folders are always kept
# Databases and Valkey listen on the server only (127.0.0.1). Installs check free memory first.
# Output: progress lines, then one JSON line {"ok":…,"action":…,"component":…,"error":…,"components":[…],"host":{…}}.
set -u
export LC_ALL=C
ACTION='{{ action }}'
COMPONENT='{{ component }}'
WANT_VERSION='{{ version }}'   # not VERSION: /etc/os-release defines that ("2023")
[[ "$ACTION" =~ ^(list|install|start|stop|remove)$ ]] || { echo '{"ok":false,"error":"invalid action"}'; exit 2; }
[[ "$COMPONENT" =~ ^(|postgresql|mariadb|valkey|sqlite|python)$ ]] || { echo '{"ok":false,"error":"invalid component"}'; exit 2; }
[[ "$WANT_VERSION" =~ ^[0-9]{0,2}(\.[0-9]{1,2})?$ ]] || { echo '{"ok":false,"error":"invalid version"}'; exit 2; }
[[ "$ACTION" == list || -n "$COMPONENT" ]] || { echo '{"ok":false,"error":"choose a component"}'; exit 2; }

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
ERR=""
fail() { ERR="$*"; log "✘ $*"; }
mem_avail_mb() { awk '/MemAvailable/ {a=$2} /SwapFree/ {s=$2} END {print int((a + s/2) / 1024)}' /proc/meminfo; }
need_mb() { local need=$1 have; have="$(mem_avail_mb)"; (( have >= need )) || { fail "needs about ${need} MB of free memory and the server has ${have} MB: stop something first or use a larger instance"; return 1; }; }
need_disk() { local gb=$(( $(df --output=avail -k / | tail -1) / 1048576 )); (( gb >= 1 )) || { fail "less than 1 GB free on the disk"; return 1; }; }
installed() { rpm -q "$1" >/dev/null 2>&1; }
available() { dnf -q list --available "$1" >/dev/null 2>&1; }
dnf_install() { log "installing $*"; dnf -y -q install "$@" >/tmp/opscomp-dnf.log 2>&1 || { tail -3 /tmp/opscomp-dnf.log; fail "package install failed ($*)"; return 1; }; }
console_host() { systemctl is-active --quiet ops-console 2>/dev/null; }
pg_pkg() { rpm -qa --qf '%{NAME}\n' | grep -E '^postgresql[0-9]+-server$' | head -1; }

# read in a sub-shell: /etc/os-release sets VERSION, NAME, ID… and must not overwrite this script's variables
OS="$( . /etc/os-release 2>/dev/null; printf '%s|%s|%s' "${ID:-}" "${VERSION_ID:-}" "${PRETTY_NAME:-unknown}" )"
if [[ "${OS%%|*}" != amzn || "$(cut -d'|' -f2 <<<"$OS")" != 2023* ]]; then
  fail "only Amazon Linux 2023 is supported for now (this is ${OS##*|})"
fi

# ------------------------------------------------------------------ actions
if [[ -z "$ERR" && "$ACTION" == install ]]; then
  need_disk || true
  case "$COMPONENT" in
    postgresql)
      cur="$(pg_pkg)"
      if [[ -n "$cur" ]]; then fail "PostgreSQL ${cur//[^0-9]/} is already installed (one version per server)"
      else
        v="${WANT_VERSION:-}"; [[ -n "$v" ]] || for c in 17 16 15; do available "postgresql$c-server" && { v=$c; break; }; done
        [[ "$v" =~ ^1[5-9]$ ]] && available "postgresql$v-server" || fail "PostgreSQL ${v:-?} is not offered by this OS"
        [[ -z "$ERR" ]] && need_mb 150 && dnf_install "postgresql$v-server" "postgresql$v"
        if [[ -z "$ERR" ]]; then
          [[ -f /var/lib/pgsql/data/PG_VERSION ]] || postgresql-setup --initdb >/dev/null 2>&1 || fail "postgresql initdb failed"
        fi
        if [[ -z "$ERR" ]]; then
          systemctl enable --quiet --now postgresql || fail "postgresql did not start"
        fi
        if [[ -z "$ERR" ]]; then
          # the same login setup as Prepare server: a generated postgres password in ~/.pgpass, password logins on localhost
          if [[ ! -s /root/.pgpass ]] || ! grep -q '^localhost:5432:\*:postgres:' /root/.pgpass; then
            PGPW="$(python3 -I -c 'import secrets; print(secrets.token_urlsafe(24))')"
            sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -c "ALTER ROLE postgres WITH PASSWORD '$PGPW'" >/dev/null || fail "could not set the postgres password"
            for h in /root /home/ec2-user; do
              [[ -d "$h" ]] || continue
              printf 'localhost:5432:*:postgres:%s\n127.0.0.1:5432:*:postgres:%s\n' "$PGPW" "$PGPW" > "$h/.pgpass"
              chmod 600 "$h/.pgpass"; chown "$(stat -c %U "$h")":"$(stat -c %G "$h")" "$h/.pgpass"
            done
            unset PGPW
          fi
          H=/var/lib/pgsql/data/pg_hba.conf
          if grep -qE '^(local|host)\s+all\s+all\s+.*(ident|peer)\s*$' "$H"; then
            cp -p "$H" "$H.ops-console.bak"; sed -i -E 's/^((local|host)\s+all\s+all\s+.*)(ident|peer)\s*$/\1md5/' "$H"; systemctl reload postgresql
          fi
          log "✔ PostgreSQL $v (password logins on localhost)"
        fi
      fi ;;
    mariadb)
      if rpm -qa --qf '%{NAME}\n' | grep -qE '^mariadb[0-9]+-server$'; then log "MariaDB is already installed"
      else
        pkg=""; for c in 1011 105; do [[ -n "$WANT_VERSION" && "$WANT_VERSION" != "${c:0:2}.${c:2}" ]] && continue; available "mariadb$c-server" && { pkg="mariadb$c-server"; break; }; done
        [[ -n "$pkg" ]] || fail "MariaDB ${WANT_VERSION:-} is not offered by this OS"
        [[ -z "$ERR" ]] && need_mb 300 && dnf_install "$pkg"
        if [[ -z "$ERR" ]]; then
          MEM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
          { echo '[mysqld]'; echo 'bind-address = 127.0.0.1'; echo 'skip-name-resolve'
            if (( MEM_MB < 2048 )); then echo '# small server: keep memory low'; echo 'innodb_buffer_pool_size = 64M'; echo 'performance_schema = OFF'; echo 'max_connections = 40'; fi
          } > /etc/my.cnf.d/ops-console.cnf
          systemctl enable --quiet --now mariadb || fail "mariadb did not start"
        fi
        if [[ -z "$ERR" ]]; then
          # root logs in through the server's socket only (MariaDB's default); remove the anonymous users and the test database
          mariadb -e "DELETE FROM mysql.global_priv WHERE User=''; DROP DATABASE IF EXISTS test; FLUSH PRIVILEGES;" >/dev/null 2>&1 || log "⚠ could not tidy the default users"
          log "✔ MariaDB ($pkg), on 127.0.0.1 only"
        fi
      fi ;;
    valkey)
      if installed valkey; then log "Valkey is already installed"
      else
        need_mb 64 && dnf_install valkey
        if [[ -z "$ERR" ]]; then
          MEM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 )); CAP=$(( MEM_MB / 8 )); (( CAP < 32 )) && CAP=32
          C=/etc/valkey/valkey.conf
          printf 'bind 127.0.0.1 -::1\nprotected-mode yes\nmaxmemory %smb\nmaxmemory-policy noeviction\n' "$CAP" > /etc/valkey/ops-console.conf
          grep -q '^include /etc/valkey/ops-console.conf' "$C" || echo 'include /etc/valkey/ops-console.conf' >> "$C"
          systemctl enable --quiet --now valkey || fail "valkey did not start"
          [[ -z "$ERR" ]] && log "✔ Valkey on 127.0.0.1:6379 (up to ${CAP} MB, refuses new writes when full)"
        fi
      fi ;;
    sqlite)
      installed sqlite && log "SQLite is already installed" || { dnf_install sqlite && log "✔ SQLite (the command-line tool, used for backups)"; } ;;
    python)
      [[ "$WANT_VERSION" =~ ^3\.1[0-9]$ ]] || fail "choose a Python version (for example 3.12)"
      if [[ -z "$ERR" ]]; then
        if installed "python$WANT_VERSION"; then log "Python $WANT_VERSION is already installed"
        else available "python$WANT_VERSION" || fail "Python $WANT_VERSION is not offered by this OS"
             [[ -z "$ERR" ]] && dnf_install "python$WANT_VERSION" "python$WANT_VERSION-pip" && log "✔ Python $WANT_VERSION (python$WANT_VERSION; apps get their own virtual environments)"
        fi
      fi ;;
  esac
fi

if [[ -z "$ERR" && ( "$ACTION" == start || "$ACTION" == stop ) ]]; then
  case "$COMPONENT" in
    postgresql) unit=postgresql; [[ -n "$(pg_pkg)" ]] || fail "PostgreSQL is not installed" ;;
    mariadb) unit=mariadb; rpm -qa --qf '%{NAME}\n' | grep -qE '^mariadb[0-9]+-server$' || fail "MariaDB is not installed" ;;
    valkey) unit=valkey; installed valkey || fail "Valkey is not installed" ;;
    *) fail "$COMPONENT has nothing to start or stop" ;;
  esac
  if [[ -z "$ERR" && "$ACTION" == stop && "$COMPONENT" == postgresql ]] && console_host; then
    fail "the Ops Console runs on this server and keeps its own data in PostgreSQL: it can't be stopped here"
  fi
  if [[ -z "$ERR" ]]; then
    if [[ "$ACTION" == start ]]; then systemctl enable --quiet --now "$unit" || fail "$unit did not start"
    else systemctl disable --quiet --now "$unit" || fail "$unit did not stop"; fi
    [[ -z "$ERR" ]] && log "✔ $unit ${ACTION}ed"
  fi
fi

if [[ -z "$ERR" && "$ACTION" == remove ]]; then
  case "$COMPONENT" in
    postgresql) fail "PostgreSQL is not removed from the console: it holds the apps' data (and backups depend on it)" ;;
    mariadb)
      pkg="$(rpm -qa --qf '%{NAME}\n' | grep -E '^mariadb[0-9]+-server$' | head -1)"
      if [[ -z "$pkg" ]]; then log "MariaDB is not installed"
      else
        own="$(mariadb -N -e "SELECT count(*) FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys')" 2>/dev/null || echo '?')"
        if [[ "$own" != 0 ]]; then fail "MariaDB still has ${own} database(s): it is only removed when it holds none"
        else systemctl disable --quiet --now mariadb 2>/dev/null; dnf -y -q remove "$pkg" >/dev/null 2>&1 || fail "could not remove $pkg"
             [[ -z "$ERR" ]] && log "✔ MariaDB removed (its data folder /var/lib/mysql is kept)"
        fi
      fi ;;
    valkey) systemctl disable --quiet --now valkey 2>/dev/null; installed valkey && { dnf -y -q remove valkey >/dev/null 2>&1 || fail "could not remove valkey"; }; [[ -z "$ERR" ]] && log "✔ Valkey removed (/var/lib/valkey is kept)" ;;
    sqlite) installed sqlite && { dnf -y -q remove sqlite >/dev/null 2>&1 || fail "could not remove sqlite"; }; [[ -z "$ERR" ]] && log "✔ SQLite tool removed (database files are kept)" ;;
    python)
      [[ "$WANT_VERSION" =~ ^3\.1[0-9]$ ]] || fail "choose the Python version to remove"
      if [[ -z "$ERR" ]]; then
        installed "python$WANT_VERSION" && { dnf -y -q remove "python$WANT_VERSION" "python$WANT_VERSION-pip" >/dev/null 2>&1 || fail "could not remove python$WANT_VERSION"; }
        [[ -z "$ERR" ]] && log "✔ Python $WANT_VERSION removed"
      fi ;;
  esac
fi

# ------------------------------------------------------------------ the inventory (always: the result shows the new state)
python3 -I - "$ACTION" "$COMPONENT" "$ERR" <<'PY'
import json, re, subprocess, sys
action, component, err = sys.argv[1], sys.argv[2], sys.argv[3]
def sh(*a):
    try: return subprocess.run(a, capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception: return ''
rpms = {}
for line in sh('rpm', '-qa', '--qf', '%{NAME} %{VERSION}\n').splitlines():
    n, _, v = line.partition(' '); rpms[n] = v
avail = {}
out = sh('dnf', '-q', 'list', '--available', 'postgresql1[5-9]-server', 'mariadb*-server', 'valkey', 'sqlite', 'python3.1[0-9]', 'nodejs[0-9][0-9]')
for line in out.splitlines()[1:] if out else []:
    parts = line.split()
    if len(parts) >= 2: avail[parts[0].rsplit('.', 1)[0]] = parts[1].split(':')[-1].split('-')[0]
def active(unit):
    s = sh('systemctl', 'is-active', unit)
    return s == 'active' if s else None
def mem(proc):
    total = 0
    for line in sh('ps', '-C', proc, '-o', 'rss=').splitlines():
        try: total += int(line)
        except ValueError: pass
    return round(total / 1024) if total else 0
def ver(full, n=2): return '.'.join(full.split('.')[:n]) if full else None
comps = []
pg = next((n for n in rpms if re.fullmatch(r'postgresql\d+-server', n)), None)
comps.append({'id': 'postgresql', 'name': 'PostgreSQL', 'category': 'database', 'installed': bool(pg), 'version': rpms.get(pg) if pg else None,
              'active': active('postgresql') if pg else None, 'memoryMb': mem('postgres') if pg else 0, 'needMb': 150, 'service': 'postgresql',
              'offered': sorted({re.sub(r'\D', '', n) for n in avail if re.fullmatch(r'postgresql\d+-server', n)} | ({re.sub(r'\D', '', pg)} if pg else set()), key=int),
              'note': 'One version per server.'})
mdb = next((n for n in rpms if re.fullmatch(r'mariadb\d+-server', n)), None)
comps.append({'id': 'mariadb', 'name': 'MariaDB (MySQL-compatible)', 'category': 'database', 'installed': bool(mdb), 'version': rpms.get(mdb) if mdb else None,
              'active': active('mariadb') if mdb else None, 'memoryMb': mem('mariadbd') if mdb else 0, 'needMb': 300, 'service': 'mariadb',
              'offered': sorted({(lambda d: f'{d[:2]}.{d[2:]}')(re.sub(r'\D', '', n)) for n in avail if re.fullmatch(r'mariadb\d+-server', n)}, key=lambda v: [int(x) for x in v.split('.')], reverse=True),
              'note': 'Works with MySQL clients and drivers.'})
comps.append({'id': 'sqlite', 'name': 'SQLite', 'category': 'database', 'installed': 'sqlite' in rpms, 'version': rpms.get('sqlite'), 'active': None, 'memoryMb': 0, 'needMb': 0,
              'service': None, 'offered': [ver(avail['sqlite'])] if 'sqlite' in avail else [], 'note': 'A database in a file: no server process. The tool is used for backups.'})
comps.append({'id': 'valkey', 'name': 'Valkey (Redis-compatible)', 'category': 'service', 'installed': 'valkey' in rpms, 'version': rpms.get('valkey'),
              'active': active('valkey') if 'valkey' in rpms else None, 'memoryMb': mem('valkey-server') if 'valkey' in rpms else 0, 'needMb': 64, 'service': 'valkey',
              'offered': [ver(avail['valkey'])] if 'valkey' in avail else [], 'note': 'Cache, sessions and job queues (BullMQ, Celery, RQ).'})
pys = sorted([n[len('python'):] for n in rpms if re.fullmatch(r'python3\.1\d', n)], key=lambda v: [int(x) for x in v.split('.')])
comps.append({'id': 'python', 'name': 'Python', 'category': 'runtime', 'installed': bool(pys), 'version': ', '.join(pys) or None, 'versions': pys, 'active': None, 'memoryMb': 0, 'needMb': 0,
              'service': None, 'offered': sorted({n[len('python'):] for n in avail if re.fullmatch(r'python3\.1\d', n)} | set(pys), key=lambda v: [int(x) for x in v.split('.')]),
              'note': 'Several versions can be installed side by side; each app gets its own virtual environment.'})
node = sh('node', '-v').lstrip('v')
comps.append({'id': 'nodejs', 'name': 'Node.js', 'category': 'runtime', 'installed': bool(node), 'version': node or None, 'active': None, 'memoryMb': 0, 'needMb': 0, 'service': None,
              'offered': sorted({re.sub(r'\D', '', n) for n in avail if re.fullmatch(r'nodejs\d+', n)}, key=int), 'note': 'Installed by Prepare server.', 'readOnly': True})
ng = rpms.get('nginx')
comps.append({'id': 'nginx', 'name': 'nginx', 'category': 'service', 'installed': bool(ng), 'version': ng, 'active': active('nginx') if ng else None, 'memoryMb': mem('nginx') if ng else 0,
              'needMb': 0, 'service': 'nginx', 'offered': [], 'note': 'Web server in front of the apps (HTTPS). Installed by Prepare server.', 'readOnly': True})
mi = {}
for line in open('/proc/meminfo'):
    k, v = line.split(':'); mi[k] = int(v.split()[0]) // 1024
host = {'memoryTotalMb': mi.get('MemTotal'), 'memoryAvailableMb': mi.get('MemAvailable'), 'swapFreeMb': mi.get('SwapFree'),
        'consoleHost': subprocess.run(['systemctl', 'is-active', '--quiet', 'ops-console']).returncode == 0}
print(json.dumps({'ok': not err, 'action': action, 'component': component or None, 'error': err or None, 'components': comps, 'host': host}))
PY
[[ -z "$ERR" ]]
