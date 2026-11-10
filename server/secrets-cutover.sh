#!/usr/bin/env bash
# =============================================================================
# secrets-cutover.sh <project|all> — one-time move of an app's secrets from its
# systemd unit / .env file to SSM Parameter Store. Runs ON the server.
#
# Per project:
#   1. preflight: instance role works, loader fetches /apps/<SERVICE>/* and the
#      result is IDENTICAL (per key, compared by hash) to the running process env
#   2. back up the current unit (and .env, if any) to /root/secrets-cutover-backup/
#   3. install /usr/local/bin/load-app-secrets + systemd/<SERVICE>.service from this repo
#   4. daemon-reload, restart, health check
#   5. on failure: restore the backed-up unit, restart, exit non-zero
#
# Safe to re-run: a project whose unit already matches the repo is skipped.
# Usage via laptop/CI:  ./deploy.sh secrets-cutover liftparcel
# =============================================================================
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR=/root/secrets-cutover-backup
TS="$(date -u +%Y%m%dT%H%M%SZ)"

log()  { printf '\e[36m[%s] %s\e[0m\n' "${P:-cutover}" "$*"; }
ok()   { printf '\e[32m[%s] ✔ %s\e[0m\n' "${P:-cutover}" "$*"; }
die()  { printf '\e[31m[%s] ✘ %s\e[0m\n' "${P:-cutover}" "$*" >&2; exit 1; }

health() { # health <url> <timeout>
  local deadline=$((SECONDS + $2)) code
  while ((SECONDS < deadline)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$1" || true)"
    [[ "$code" =~ ^2 ]] && return 0
    sleep 3
  done
  return 1
}

# key=sha256(value) for every key in an env stream (NUL- or newline-separated)
hash_env() {
  python3 -I -c '
import sys, hashlib, re
data = sys.stdin.buffer.read().decode()
sep = "\0" if "\0" in data else "\n"
wanted = set(sys.argv[1:])
for line in data.split(sep):
    if "=" not in line: continue
    k, v = line.split("=", 1)
    if sep == "\n":                      # EnvironmentFile format: KEY="escaped"
        v = v[1:-1].replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")
    if k in wanted:
        print(k, hashlib.sha256(v.encode()).hexdigest())
' "$@" | sort
}

cutover() {
  P="$1"
  local conf="$ROOT/projects/$P.conf"
  [[ -f "$conf" ]] || die "unknown project $P"
  local SERVICE HEALTH_URL HEALTH_TIMEOUT
  SERVICE="$(bash -c "source '$conf'; echo \$SERVICE")"
  HEALTH_URL="$(bash -c "source '$conf'; echo \$HEALTH_URL")"
  HEALTH_TIMEOUT="$(bash -c "source '$conf'; echo \${HEALTH_TIMEOUT:-90}")"
  local new_unit="$ROOT/systemd/$SERVICE.service" live_unit="/etc/systemd/system/$SERVICE.service"
  [[ -f "$new_unit" ]] || die "no $new_unit in repo"

  if sudo cmp -s "$new_unit" "$live_unit"; then ok "already cut over — skipping"; return 0; fi

  log "preflight: instance role + SSM access"
  aws sts get-caller-identity --query Arn --output text >/dev/null 2>&1 \
    || die "no AWS credentials on the instance — attach the instance profile first (scripts/setup-aws-iam.sh)"
  sudo install -m 0755 -o root -g root "$ROOT/server/load-app-secrets.sh" /usr/local/bin/load-app-secrets
  sudo /usr/local/bin/load-app-secrets "$SERVICE"

  log "preflight: SSM values must equal the running process environment"
  local keys pid
  keys="$(sudo sed -E 's/=.*//' "/run/app-secrets/$SERVICE.env" | paste -sd' ')"
  pid="$(systemctl show -p MainPID --value "$SERVICE")"
  [[ "$pid" != 0 ]] || die "$SERVICE is not running — cannot verify"
  # shellcheck disable=SC2086
  if ! diff <(sudo cat "/proc/$pid/environ" | hash_env $keys) \
            <(sudo cat "/run/app-secrets/$SERVICE.env" | hash_env $keys) >/dev/null; then
    die "values in SSM differ from the running app (keys: $keys) — aborting, nothing changed"
  fi
  ok "$(wc -w <<<"$keys") variables match"
  local before; before="$(sudo cat "/proc/$pid/environ" | hash_env $keys)"

  log "backing up current unit → $BACKUP_DIR"
  sudo install -d -m 0700 "$BACKUP_DIR"
  sudo install -m 0600 "$live_unit" "$BACKUP_DIR/$SERVICE.service.$TS"
  local envfile
  envfile="$(systemctl show -p EnvironmentFiles --value "$SERVICE" | awk '{print $1}')"
  [[ -n "$envfile" && "$envfile" != /run/app-secrets/* && -f "$envfile" ]] \
    && sudo install -m 0600 "$envfile" "$BACKUP_DIR/$SERVICE.env.$TS"

  log "installing new unit + restarting"
  sudo install -m 0644 "$new_unit" "$live_unit"
  sudo systemctl daemon-reload
  sudo systemctl restart "$SERVICE"

  local healthy=0
  if health "$HEALTH_URL" "$HEALTH_TIMEOUT"; then
    pid="$(systemctl show -p MainPID --value "$SERVICE")"
    # shellcheck disable=SC2086
    if [[ "$(sudo cat "/proc/$pid/environ" | hash_env $keys)" == "$before" ]]; then healthy=1
    else printf '\e[31m[%s] new process environment differs from the old one\e[0m\n' "$P" >&2; fi
  fi

  if ((healthy)); then
    ok "healthy, and the new process sees identical values (loaded from SSM)"
    if [[ -n "$envfile" && "$envfile" != /run/app-secrets/* && -f "$envfile" ]]; then
      sudo mv "$envfile" "$BACKUP_DIR/$(basename "$envfile").moved.$TS"
      ok "moved old $envfile into $BACKUP_DIR (root-only)"
    fi
    return 0
  fi

  printf '\e[31m[%s] unhealthy — restoring previous unit\e[0m\n' "$P" >&2
  sudo journalctl -u "$SERVICE" -n 25 --no-pager >&2 || true
  sudo install -m 0644 "$BACKUP_DIR/$SERVICE.service.$TS" "$live_unit"
  sudo systemctl daemon-reload
  sudo systemctl restart "$SERVICE"
  health "$HEALTH_URL" "$HEALTH_TIMEOUT" && echo "restored and healthy" >&2
  return 1
}

target="${1:?usage: secrets-cutover.sh <project|all>}"
if [[ "$target" == all ]]; then
  mapfile -t projects < <(find "$ROOT/projects" -maxdepth 1 -name '*.conf' ! -name '_*' -printf '%f\n' | sed 's/\.conf$//' | sort)
else
  projects=("$target")
fi
failed=()
for p in "${projects[@]}"; do
  set +e; ( set -e; cutover "$p" ); rc=$?; set -e   # not in `if`, so set -e applies inside
  ((rc == 0)) || failed+=("$p")
done
((${#failed[@]} == 0)) || { echo "FAILED: ${failed[*]}" >&2; exit 1; }
echo "secrets cutover complete: ${projects[*]}"
echo "After verifying, delete the backups (they contain the old plaintext secrets): sudo rm -rf $BACKUP_DIR"
