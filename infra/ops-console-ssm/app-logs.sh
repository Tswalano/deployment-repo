#!/bin/bash
# OpsConsole-AppLogs: the last N journal lines of ONE project's systemd unit. Read-only.
# Obvious secrets (bearer tokens, password=/token=/secret=/api key values, connection-string passwords)
# are masked before anything leaves the box. Output: base64(gzip(text)), kept under SSM's 24 KB output limit.
set -u
export LC_ALL=C
PROJECT='{{ project }}'
LINES='{{ lines }}'

fail() { echo "ops-console: $*" >&2; exit 2; }
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "invalid project"
[[ "$LINES" =~ ^[0-9]{1,3}$ ]] && (( LINES >= 10 && LINES <= 500 )) || fail "lines must be 10-500"
CONF="/opt/deploy/projects/$PROJECT.conf"
[[ -f "$CONF" ]] || fail "unknown project '$PROJECT'"
SERVICE="$(sed -n 's/^SERVICE="\([A-Za-z0-9_.@-]*\)".*/\1/p' "$CONF" | head -1)"
[[ -n "$SERVICE" ]] || fail "no SERVICE in $PROJECT.conf"

while :; do
  out="$(journalctl -u "$SERVICE" -n "$LINES" --no-pager -o short-iso 2>&1 \
    | sed -E 's/\x1b\[[0-9;]*m//g;
              s/([Bb]earer )[A-Za-z0-9._~+\/=-]+/\1[redacted]/g;
              s/((password|passwd|secret|token|api[_-]?key|authorization)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?)[^"'"'"'[:space:],}]+/\1[redacted]/Ig;
              s#(://[^:/@[:space:]]+:)[^@/[:space:]]+@#\1[redacted]@#g' \
    | cut -c1-400 | gzip -9c | base64 -w0)"
  if (( ${#out} <= 22000 || LINES <= 10 )); then break; fi
  LINES=$(( LINES / 2 ))
done
printf '%s' "$out"
