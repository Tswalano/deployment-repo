#!/bin/bash
# OpsConsole-Deploy: deploy or roll back ONE project with the existing pipeline (server/pipeline.sh).
# Runs as root via SSM; the pipeline itself runs as ec2-user, exactly like a CI or manual deploy
# (same lock, pre-deploy DB backup, migrations, health check and auto-rollback).
# SSM substitutes the double-brace parameters below textually. Each one is limited by an allowedPattern in the
# document AND re-checked here, and none can contain quotes, spaces or shell metacharacters.
# Output: the pipeline log without colour codes (last 20 KB). Exit code: the pipeline's.
set -u
ACTION='{{ action }}'
PROJECT='{{ project }}'
REF='{{ ref }}'
ACTOR='{{ actor }}'

fail() { echo "ops-console: $*"; exit 2; }
case "$ACTION" in deploy|rollback) ;; *) fail "unknown action" ;; esac
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "invalid project"
[[ -f "/opt/deploy/projects/$PROJECT.conf" ]] || fail "unknown project '$PROJECT'"
[[ -z "$REF" || "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ ]] || fail "invalid ref"
[[ "$REF" == *..* ]] && fail "invalid ref"
if [[ "$ACTION" == rollback && -n "$REF" && ! "$REF" =~ ^[0-9a-f]{7,40}$ ]]; then fail "rollback takes a commit sha"; fi
[[ "$ACTOR" =~ ^[A-Za-z0-9._@:-]{1,64}$ ]] || fail "invalid actor"

args=("$ACTION" "$PROJECT")
[[ -n "$REF" ]] && args+=("$REF")
LOG="$(mktemp /tmp/opsconsole-deploy.XXXXXX)"
runuser -u ec2-user -- env -i HOME=/home/ec2-user USER=ec2-user LOGNAME=ec2-user LANG=C.UTF-8 \
  PATH=/usr/local/bin:/usr/bin:/bin DEPLOY_ACTOR="$ACTOR" DEPLOY_TRIGGER=ops-console \
  bash /opt/deploy/server/pipeline.sh "${args[@]}" >"$LOG" 2>&1 </dev/null
rc=$?
sed 's/\x1b\[[0-9;]*m//g' "$LOG" | tail -c 20000
rm -f "$LOG"
exit $rc
