#!/usr/bin/env bash
# =============================================================================
# rotate-secrets.sh — rotate the secrets this repo can rotate on its own:
#   * Postgres password of role `postgres`     (FinanceFlow + LiftParcel)
#   * Postgres password of role `lendify_user` (Lendify)
#   * JWT_SECRET of LiftParcel and Lendify     (⚠ logs every user of those apps out once)
#
# Run from a machine with admin AWS CLI credentials:
#   ./scripts/rotate-secrets.sh            # everything above
#   ./scripts/rotate-secrets.sh --db-only  # passwords only, no logouts
#
# How it stays safe
#   1. snapshots the current SSM values to a private temp file (0600, deleted at the end)
#   2. writes new values to SSM (encrypted SecureStrings; never printed, never on a command line)
#   3. via SSM Run Command, the box: ALTER ROLE (password read from SSM, SQL on stdin), updates
#      ~ec2-user/.pgpass, restarts each app (app-secrets@<svc> re-reads SSM), checks health
#   4. if anything fails: restores the snapshot to SSM, ALTERs the roles back, restarts the apps
#
# Third-party keys (Paystack, Sentry, Mapbox, SMTP) must be regenerated at each provider; then:
#   aws ssm put-parameter --overwrite --type SecureString --name /apps/<svc>/<KEY> --cli-input-json '{"Value":"…"}'
#   …and restart the app (sudo systemctl restart <svc>) or just deploy it.
# =============================================================================
set -Eeuo pipefail
REGION="${AWS_REGION:-af-south-1}"
INSTANCE_ID="${EC2_INSTANCE_ID:-$(aws ec2 describe-instances --region "$REGION" --filters Name=tag:Name,Values=lendify-instance Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)}"
[[ "$INSTANCE_ID" == i-* ]] || { echo "instance not running" >&2; exit 1; }
DB_ONLY=0; [[ "${1:-}" == "--db-only" ]] && DB_ONLY=1

SNAP="$(mktemp)"; chmod 600 "$SNAP"; trap 'rm -f "$SNAP"' EXIT

# ---------------------------------------------------------------- laptop side: SSM values (python: no secrets in argv/output)
ssm_rotate() { # ssm_rotate rotate|restore
  python3 -I - "$1" "$SNAP" "$REGION" "$DB_ONLY" <<'PY'
import json, secrets, subprocess, sys
mode, snap, region, db_only = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
def aws(*a):
    return subprocess.run(["aws", *a, "--region", region], capture_output=True, text=True, check=True).stdout
def get(n): return json.loads(aws("ssm", "get-parameter", "--name", n, "--with-decryption", "--output", "json"))["Parameter"]["Value"]
def put(n, v):
    subprocess.run(["aws", "ssm", "put-parameter", "--region", region, "--name", n, "--type", "SecureString",
                    "--overwrite", "--cli-input-json", json.dumps({"Value": v})], capture_output=True, text=True, check=True)
def swap_pw(url, user, new):
    scheme, rest = url.split("://", 1)
    creds, host = rest.rsplit("@", 1)          # old passwords may contain an unescaped '@'
    if creds.split(":", 1)[0] != user: raise SystemExit(f"unexpected user in URL (expected {user})")
    return f"{scheme}://{user}:{new}@{host}"
pw = lambda: "".join(c if c.isalnum() else "x" for c in secrets.token_urlsafe(32))   # URL-safe, no escaping needed
keys = ["/apps/app1/DATABASE_URL", "/apps/liftparcel/DATABASE_URL", "/apps/liftparcel/DATABASE_PASSWORD",
        "/apps/lendify/DATABASE_URL"] + ([] if db_only else ["/apps/liftparcel/JWT_SECRET", "/apps/lendify/JWT_SECRET"])
if mode == "rotate":
    old = {k: get(k) for k in keys}
    if get("/apps/liftparcel/DATABASE_USER") != "postgres": raise SystemExit("liftparcel DATABASE_USER is not postgres; aborting")
    json.dump(old, open(snap, "w"))
    pg, lend = pw(), pw()
    new = {"/apps/app1/DATABASE_URL": swap_pw(old["/apps/app1/DATABASE_URL"], "postgres", pg),
           "/apps/liftparcel/DATABASE_URL": swap_pw(old["/apps/liftparcel/DATABASE_URL"], "postgres", pg),
           "/apps/liftparcel/DATABASE_PASSWORD": pg,
           "/apps/lendify/DATABASE_URL": swap_pw(old["/apps/lendify/DATABASE_URL"], "lendify_user", lend)}
    if not db_only:
        new["/apps/liftparcel/JWT_SECRET"] = secrets.token_urlsafe(48)
        new["/apps/lendify/JWT_SECRET"] = secrets.token_urlsafe(48)
    for k, v in new.items(): put(k, v); print("  ssm: rotated", k)
else:
    for k, v in json.load(open(snap)).items(): put(k, v); print("  ssm: restored", k)
PY
}

# ---------------------------------------------------------------- box side (runs as root via SSM; reads values from SSM itself)
read -r -d '' BOX <<'BOXEOF' || true
set -uo pipefail
MODE="__MODE__"
cd /tmp
ssm() { aws ssm get-parameter --region af-south-1 --name "$1" --with-decryption --query Parameter.Value --output text; }
url_pw() { python3 -I -c 'import sys; r=sys.argv[1].split("://",1)[1]; print(r.rsplit("@",1)[0].split(":",1)[1])' "$1"; }
PG_NEW="$(ssm /apps/liftparcel/DATABASE_PASSWORD)"
LEND_NEW="$(url_pw "$(ssm /apps/lendify/DATABASE_URL)")"
as_ec2() { sudo -u ec2-user -H bash -c "cd /tmp && $1"; }
psql_pg() { as_ec2 "psql -X -q -h localhost -U postgres -w -d postgres -v ON_ERROR_STOP=1"; }
# 1. change role passwords (SQL over stdin, authenticated with the CURRENT ~/.pgpass)
q() { printf '%s' "$1" | sed "s/'/''/g"; }   # SQL-quote (restore may bring back older passwords)
printf "ALTER ROLE postgres PASSWORD '%s';\nALTER ROLE lendify_user PASSWORD '%s';\n" "$(q "$PG_NEW")" "$(q "$LEND_NEW")" | psql_pg || { echo "BOX: ALTER ROLE failed"; exit 1; }
# 2. .pgpass for the pipeline's backups / migrations
esc="$(printf '%s' "$PG_NEW" | sed 's/[\\:]/\\&/g')"
printf 'localhost:5432:*:postgres:%s\n' "$esc" | as_ec2 "umask 077; cat > ~/.pgpass"
as_ec2 "psql -X -q -h localhost -U postgres -w -d postgres -tAc 'select 1'" >/dev/null || { echo "BOX: new postgres password does not work"; exit 1; }
# 3. restart apps (PartOf= re-runs app-secrets@<svc>, i.e. re-reads SSM) and health-check
fail=0
for pair in app1:3000 liftparcel:4000 lendify:8088; do
  svc=${pair%%:*}; port=${pair##*:}
  systemctl restart "$svc"
  ok=0; for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 localhost:$port/health)" = 200 ] && { ok=1; break; }; sleep 2; done
  if ((ok)); then echo "BOX: $svc healthy on new secrets"; else echo "BOX: $svc UNHEALTHY"; journalctl -u "$svc" -n 15 --no-pager; fail=1; fi
done
exit $fail
BOXEOF

run_on_box() { # run_on_box <mode> → prints output, returns box exit status
  local script="${BOX/__MODE__/$1}" cid status
  cid="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
        --comment "rotate-secrets ($1)" --parameters "$(python3 -I -c 'import json,sys; print(json.dumps({"commands": sys.stdin.read().splitlines(), "executionTimeout": ["900"]}))' <<<"$script")" \
        --query Command.CommandId --output text)"
  for _ in $(seq 1 90); do
    status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || true)"
    [[ "$status" =~ ^(Success|Failed|TimedOut|Cancelled)$ ]] && break; sleep 5
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text | sed 's/^/  /'
  [[ "$status" == Success ]]
}

echo "→ rotating secrets in SSM (instance $INSTANCE_ID)$([[ $DB_ONLY == 1 ]] && echo ', DB passwords only')"
ssm_rotate rotate
echo "→ applying on the box"
if run_on_box apply; then
  echo "✔ rotation complete. All apps healthy on the new secrets."
  ((DB_ONLY)) || echo "  (LiftParcel and Lendify users have been logged out once: their JWTs were signed with the old secret)"
else
  echo "✘ something failed on the box. Restoring the previous values…" >&2
  ssm_rotate restore
  run_on_box restore && echo "↩ restored: apps healthy on the previous secrets" >&2 || echo "‼ restore also failed: check the apps now" >&2
  exit 1
fi
