#!/usr/bin/env bash
# =============================================================================
# pipeline.sh — runs ON the EC2 host. Deploys / rolls back / reports on the
# projects described in ../projects/*.conf.
#
#   pipeline.sh list
#   pipeline.sh status   <project|all>
#   pipeline.sh deploy   <project|all> [git-ref]      (default ref: BRANCH from conf)
#   pipeline.sh rollback <project>     [git-sha]      (default: previous good deploy)
#   pipeline.sh restore-snapshot <project> <file>     (sync-mode projects only)
#   pipeline.sh history  <project>
#   pipeline.sh secrets-cutover <project|all>         (one-time: move secrets to SSM)
#
# Env flags:
#   FORCE=1           deploy even if the source checkout has uncommitted changes
#   SKIP_DB_BACKUP=1  skip the pre-migration pg_dump (not recommended)
#   NO_AUTO_ROLLBACK=1  leave a failed deploy in place for debugging
# =============================================================================
set -Eeuo pipefail

PIPELINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECTS_DIR="$PIPELINE_ROOT/projects"
STATE_ROOT="${STATE_ROOT:-/opt/deploy-state}"
LOCK_FILE="$STATE_ROOT/.pipeline.lock"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

c_info=$'\e[36m'; c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_off=$'\e[0m'
log()  { printf '%s[%s] %s%s\n' "$c_info" "${PROJECT:-pipeline}" "$*" "$c_off"; }
ok()   { printf '%s[%s] ✔ %s%s\n' "$c_ok" "${PROJECT:-pipeline}" "$*" "$c_off"; }
warn() { printf '%s[%s] ⚠ %s%s\n' "$c_warn" "${PROJECT:-pipeline}" "$*" "$c_off" >&2; }
die()  { printf '%s[%s] ✘ %s%s\n' "$c_err" "${PROJECT:-pipeline}" "$*" "$c_off" >&2; exit 1; }

# ----------------------------------------------------------------------------- config
list_projects() {
  find "$PROJECTS_DIR" -maxdepth 1 -name '*.conf' ! -name '_*' -printf '%f\n' | sed 's/\.conf$//' | sort
}

load_project() {
  PROJECT="$1"
  local conf="$PROJECTS_DIR/$PROJECT.conf"
  [[ -f "$conf" ]] || die "unknown project '$PROJECT' (no $conf). Known: $(list_projects | paste -sd' ')"
  # reset optional keys so values don't leak between projects in 'all' runs
  unset SERVICE SOURCE_DIR BRANCH APP_SUBDIR RUN_DIR INSTALL_CMD BUILD_CMD MIGRATE_CMD \
        HEALTH_URL HEALTH_TIMEOUT DB_NAME DB_USER DOMAIN SYNC_EXCLUDES
  # shellcheck source=/dev/null
  source "$conf"
  : "${SERVICE:?SERVICE missing in $conf}" "${SOURCE_DIR:?SOURCE_DIR missing in $conf}" \
    "${HEALTH_URL:?HEALTH_URL missing in $conf}"
  BRANCH="${BRANCH:-main}"
  APP_SUBDIR="${APP_SUBDIR:-.}"
  BUILD_DIR="$SOURCE_DIR/$APP_SUBDIR"; BUILD_DIR="${BUILD_DIR%/.}"
  RUN_DIR="${RUN_DIR:-$BUILD_DIR}"
  INSTALL_CMD="${INSTALL_CMD-npm ci --no-audit --no-fund}"
  BUILD_CMD="${BUILD_CMD-}"
  MIGRATE_CMD="${MIGRATE_CMD-}"
  HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
  DB_USER="${DB_USER:-postgres}"
  SYNC_EXCLUDES="${SYNC_EXCLUDES:-node_modules .env .env.* dist .git}"
  # "sync mode": code is built from a git checkout but runs from a separate dir
  SYNC_MODE=0; [[ "$(realpath -m "$RUN_DIR")" != "$(realpath -m "$BUILD_DIR")" ]] && SYNC_MODE=1
  STATE_DIR="$STATE_ROOT/$PROJECT"
  mkdir -p "$STATE_DIR/backups" "$STATE_DIR/snapshots"
  # DB dumps and code snapshots can contain data/secrets: owner-only
  chmod 700 "$STATE_DIR/backups" "$STATE_DIR/snapshots"
  HISTORY="$STATE_DIR/history.log"; touch "$HISTORY"
}

# ----------------------------------------------------------------------------- helpers
current_sha() { git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo none; }

# The successful deploy that came *before* the given sha was (last) deployed.
# Only real deploys/baselines count, so repeated rollbacks keep stepping back
# instead of bouncing forward to a newer release.
previous_good_sha() {
  awk -v cur="$1" '
    $4=="ok" && ($5=="deploy" || $5=="baseline") { shas[n++]=$2 }
    END {
      last=-1; for (i=0;i<n;i++) if (shas[i]==cur) last=i
      if (last<0) last=n            # current sha never deployed: take newest other
      for (i=last-1;i>=0;i--) if (shas[i]!=cur) { print shas[i]; exit }
    }' "$HISTORY"
}

record() { # record <sha> <ref> <status> <action>
  printf '%s %s %s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" >> "$HISTORY"
}

ensure_clean_tree() {
  local dirty
  dirty="$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=no)"
  if [[ -n "$dirty" ]]; then
    if [[ "${FORCE:-0}" == 1 ]]; then
      warn "FORCE=1: discarding local changes in $SOURCE_DIR:"; echo "$dirty" >&2
    else
      echo "$dirty" >&2
      die "uncommitted changes in $SOURCE_DIR (above). Commit/push them upstream, or re-run with FORCE=1 to discard them."
    fi
  fi
}

backup_db() {
  [[ -n "${DB_NAME:-}" ]] || { log "no DB_NAME configured — skipping DB backup"; return 0; }
  if [[ "${SKIP_DB_BACKUP:-0}" == 1 ]]; then warn "SKIP_DB_BACKUP=1 — no DB backup taken"; return 0; fi
  local out="$STATE_DIR/backups/${DB_NAME}-$(date -u +%Y%m%dT%H%M%SZ)-$(current_sha | cut -c1-8).sql.gz"
  log "backing up database '$DB_NAME' → $out"
  # Credentials come from ~/.pgpass (see README → One-time server setup)
  if (umask 077; pg_dump -h localhost -U "$DB_USER" -w --no-owner "$DB_NAME" | gzip > "$out"); then
    ok "DB backup done ($(du -h "$out" | cut -f1))"
    ls -1t "$STATE_DIR"/backups/*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
  else
    rm -f "$out"
    [[ -n "$MIGRATE_CMD" ]] && die "DB backup failed and this project runs migrations — aborting. Set up ~/.pgpass or SKIP_DB_BACKUP=1."
    warn "DB backup failed (no ~/.pgpass?) — continuing because no migrations are configured"
  fi
}

snapshot_run_dir() { # sync-mode only: tarball of the running code (excluding node_modules)
  local out="$STATE_DIR/snapshots/$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  log "snapshotting $RUN_DIR → $out"
  (umask 077; tar -C "$RUN_DIR" --exclude=node_modules -czf "$out" .)
  ls -1t "$STATE_DIR"/snapshots/*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
}

checkout() { # checkout <ref>  → leaves SOURCE_DIR at a detached SHA, echoes it
  local ref="$1"
  git -C "$SOURCE_DIR" fetch --quiet --prune origin >&2
  local sha
  sha="$(git -C "$SOURCE_DIR" rev-parse --verify --quiet "origin/$ref^{commit}" \
      || git -C "$SOURCE_DIR" rev-parse --verify --quiet "$ref^{commit}")" \
      || die "cannot resolve ref '$ref' in $SOURCE_DIR"
  git -C "$SOURCE_DIR" checkout --quiet --force --detach "$sha" >&2
  echo "$sha"
}

sync_code() {
  [[ "$SYNC_MODE" == 1 ]] || return 0
  local args=(-a --delete)
  for e in $SYNC_EXCLUDES; do args+=(--exclude "$e"); done
  log "syncing $BUILD_DIR/ → $RUN_DIR/"
  rsync "${args[@]}" "$BUILD_DIR/" "$RUN_DIR/"
}

run_in_app() { # run_in_app <label> <cmd>
  [[ -n "$2" ]] || return 0
  log "$1: $2"
  ( cd "$RUN_DIR" && bash -lc "$2" )
}

restart_service() {
  log "restarting systemd unit '$SERVICE'"
  sudo systemctl restart "$SERVICE"
}

wait_healthy() {
  log "health check $HEALTH_URL (timeout ${HEALTH_TIMEOUT}s)"
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) code
  while (( SECONDS < deadline )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$HEALTH_URL" || true)"
    if [[ "$code" =~ ^2 ]]; then ok "healthy (HTTP $code)"; return 0; fi
    if ! systemctl is-active --quiet "$SERVICE"; then warn "unit $SERVICE is not active"; fi
    sleep 3
  done
  warn "unhealthy after ${HEALTH_TIMEOUT}s (last HTTP ${code:-none}). Recent logs:"
  sudo journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
  return 1
}

# checkout+build+restart+health at the given ref; pass "migrate" as $2 to run MIGRATE_CMD.
# NOTE: callers use `if release ...`, where bash disables `set -e`, so every step
# propagates its failure explicitly.
release() { # release <ref> [migrate] → returns 0 if healthy
  local sha
  RELEASED_SHA=""
  sha="$(checkout "$1")"                  || return 1
  RELEASED_SHA="$sha"
  sync_code                               || return 1
  run_in_app install "$INSTALL_CMD"       || return 1
  run_in_app build   "$BUILD_CMD"         || return 1
  if [[ "${2:-}" == migrate ]]; then
    run_in_app migrate "$MIGRATE_CMD"     || return 1
  fi
  restart_service                         || return 1
  wait_healthy
}

# ----------------------------------------------------------------------------- commands
cmd_deploy() {
  local ref="${1:-$BRANCH}" prev
  prev="$(current_sha)"
  log "deploy ref=$ref  (currently at ${prev:0:8}, service=$SERVICE, run_dir=$RUN_DIR)"
  ensure_clean_tree
  [[ "$SYNC_MODE" == 1 ]] && snapshot_run_dir
  backup_db
  # make sure the pre-deploy SHA is known as a rollback target on the very first run
  grep -q " $prev " "$HISTORY" || record "$prev" "pre-pipeline" ok baseline

  if release "$ref" migrate; then
    record "$RELEASED_SHA" "$ref" ok deploy
    ok "deployed ${RELEASED_SHA:0:8} ($ref)"
    return 0
  fi

  record "${RELEASED_SHA:-unknown}" "$ref" failed deploy
  if [[ "${NO_AUTO_ROLLBACK:-0}" == 1 ]]; then die "deploy failed; NO_AUTO_ROLLBACK=1 so leaving it in place"; fi
  warn "deploy failed — rolling back to ${prev:0:8}"
  [[ -n "$MIGRATE_CMD" ]] && warn "migrations are NOT reverted automatically; latest DB backup is in $STATE_DIR/backups/"
  if release "$prev"; then record "$prev" "auto-rollback" ok rollback; ok "rolled back to ${prev:0:8}"
  else record "$prev" "auto-rollback" failed rollback; warn "ROLLBACK ALSO FAILED — manual intervention needed"; fi
  return 1
}

cmd_rollback() {
  local target="${1:-}" cur; cur="$(current_sha)"
  [[ -n "$target" ]] || target="$(previous_good_sha "$cur")"
  [[ -n "$target" ]] || die "no previous successful deploy in $HISTORY; pass a SHA explicitly"
  log "rollback ${cur:0:8} → ${target:0:8}"
  FORCE=1 ensure_clean_tree   # rollback is an emergency path: never blocked by a dirty tree
  if release "$target"; then record "$RELEASED_SHA" "rollback" ok rollback; ok "rolled back to ${RELEASED_SHA:0:8}"
  else record "$target" "rollback" failed rollback; die "rollback target is unhealthy too — check logs above"; fi
}

cmd_restore_snapshot() {
  [[ "$SYNC_MODE" == 1 ]] || die "restore-snapshot is only for sync-mode projects (RUN_DIR != SOURCE_DIR/APP_SUBDIR)"
  local file="${1:-$(ls -1t "$STATE_DIR"/snapshots/*.tar.gz 2>/dev/null | head -1)}"
  [[ -f "$file" ]] || die "snapshot not found: ${file:-<none>}"
  log "restoring $file → $RUN_DIR"
  find "$RUN_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name '.env*' -exec rm -rf {} +
  tar -C "$RUN_DIR" -xzf "$file"
  run_in_app install "$INSTALL_CMD"
  restart_service
  wait_healthy && record "snapshot:$(basename "$file")" restore ok rollback
}

cmd_status() {
  local active code
  active="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$HEALTH_URL" || true)"
  printf '%-12s %-11s unit=%-9s health=%-4s sha=%-8s branch=%-10s %s\n' \
    "$PROJECT" "$SERVICE" "$active" "$code" "$(current_sha | cut -c1-8)" \
    "$(b="$(git -C "$SOURCE_DIR" branch --show-current 2>/dev/null)"; echo "${b:-detached}")" "${DOMAIN:-}"
}

cmd_history() { tail -n "${N:-20}" "$HISTORY"; }

# ----------------------------------------------------------------------------- main
usage() { sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

main() {
  local cmd="${1:-}"; shift || true
  [[ -n "$cmd" ]] || usage
  sudo mkdir -p "$STATE_ROOT" && sudo chown "$(id -un)" "$STATE_ROOT"

  case "$cmd" in
    list) list_projects; return ;;
    secrets-cutover) exec bash "$PIPELINE_ROOT/server/secrets-cutover.sh" "$@" ;;
    -h|--help|help) usage ;;
  esac

  local target="${1:-}"; shift || true
  [[ -n "$target" ]] || usage
  local projects=("$target")
  [[ "$target" == all ]] && mapfile -t projects < <(list_projects)

  case "$cmd" in
    status) for p in "${projects[@]}"; do ( load_project "$p"; cmd_status ); done; return ;;
    history) load_project "$target"; cmd_history; return ;;
  esac

  # mutating commands: one pipeline run at a time on this host
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another pipeline run holds $LOCK_FILE"

  if [[ "$target" == all ]]; then
    [[ "$cmd" == deploy ]] || die "'$cmd' must target a single project"
    (($#)) && warn "ignoring ref '$1' for 'all' — each project deploys its own BRANCH"
    set --
  fi

  # Each project runs in its own subshell (isolated config, set -e active) so one
  # failure doesn't stop the others. Deliberately NOT inside `if (...)`, which
  # would disable set -e within the subshell.
  local failed=() rc
  for p in "${projects[@]}"; do
    set +e
    (
      set -e
      load_project "$p"
      case "$cmd" in
        deploy)           cmd_deploy "$@" ;;
        rollback)         cmd_rollback "$@" ;;
        restore-snapshot) cmd_restore_snapshot "$@" ;;
        *) usage ;;
      esac
    )
    rc=$?
    set -e
    ((rc == 0)) || failed+=("$p")
  done

  echo
  if ((${#failed[@]})); then
    printf '%sFAILED: %s%s\n' "$c_err" "${failed[*]}" "$c_off"; exit 1
  fi
  printf '%sAll done: %s%s\n' "$c_ok" "${projects[*]}" "$c_off"
}

main "$@"
