#!/usr/bin/env bash
# Create/update the Ops Console's SSM documents in a region (run once per region with managed instances).
#   ./infra/ops-console-ssm/deploy.sh [region]
# Documents are fixed scripts: the console can run THESE and nothing else (see infra/iam/instance-ops-console.json).
set -Eeuo pipefail
cd "$(dirname "$0")"
REGION="${1:-${AWS_REGION:-af-south-1}}"

doc_json() { # doc_json <script-file> <description> <timeout-seconds> [parameters-json]
  python3 -I - "$1" "$2" "$3" "${4:-}" <<'PY'
import json, sys
lines = open(sys.argv[1]).read().splitlines()
doc = {
  "schemaVersion": "2.2",
  "description": sys.argv[2],
  "mainSteps": [{"action": "aws:runShellScript", "name": "run",
                 "inputs": {"timeoutSeconds": sys.argv[3], "runCommand": lines}}],
}
params = json.loads(sys.argv[4] or "{}")
if params:
    doc["parameters"] = params
print(json.dumps(doc))
PY
}

upsert() { # upsert <name> <script> <description> <timeout-seconds> [parameters-json]
  local name=$1 content; content="$(doc_json "$2" "$3" "$4" "${5:-}")"
  if aws ssm describe-document --region "$REGION" --name "$name" >/dev/null 2>&1; then
    local v
    v="$(aws ssm update-document --region "$REGION" --name "$name" --content "$content" --document-version '$LATEST' \
          --query DocumentDescription.DocumentVersion --output text 2>/dev/null)" || { echo "  $name: unchanged"; return; }
    aws ssm update-document-default-version --region "$REGION" --name "$name" --document-version "$v" >/dev/null
    echo "  $name: updated → v$v"
  else
    aws ssm create-document --region "$REGION" --name "$name" --document-type Command --document-format JSON \
        --content "$content" --tags Key=managed-by,Value=deployment-repo >/dev/null
    echo "  $name: created"
  fi
}

# Every parameter is pinned by allowedPattern/allowedValues (the scripts re-check them):
# no quotes, spaces or shell metacharacters can reach the command line.
DEPLOY_PARAMS='{
  "action":  {"type": "String", "allowedValues": ["deploy", "rollback"]},
  "project": {"type": "String", "allowedPattern": "^[a-z0-9][a-z0-9-]{0,31}$"},
  "ref":     {"type": "String", "default": "", "allowedPattern": "^$|^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$"},
  "actor":   {"type": "String", "allowedPattern": "^[A-Za-z0-9._@:-]{1,64}$"}
}'
LOGS_PARAMS='{
  "project": {"type": "String", "allowedPattern": "^[a-z0-9][a-z0-9-]{0,31}$"},
  "lines":   {"type": "String", "default": "200", "allowedPattern": "^[0-9]{2,4}$"},
  "level":   {"type": "String", "default": "all", "allowedValues": ["all", "warning", "error"]},
  "since":   {"type": "String", "default": "24h", "allowedValues": ["15m", "1h", "6h", "24h", "7d", "boot"]},
  "q":       {"type": "String", "default": "", "allowedPattern": "^[A-Za-z0-9 ._:/@#=-]{0,60}$"}
}'
DETAIL_PARAMS='{
  "project": {"type": "String", "allowedPattern": "^[a-z0-9][a-z0-9-]{0,31}$"},
  "fetch":   {"type": "String", "default": "no", "allowedValues": ["no", "yes"]}
}'

echo "→ SSM documents in $REGION"
upsert OpsConsole-CollectStatus collect-status.sh "Ops Console: read-only status snapshot (no parameters)" 60
upsert OpsConsole-Deploy deploy-app.sh "Ops Console: deploy or roll back one project via server/pipeline.sh" 1800 "$DEPLOY_PARAMS"
upsert OpsConsole-AppLogs app-logs.sh "Ops Console: filtered log entries of one project (secrets masked)" 60 "$LOGS_PARAMS"
BACKUP_PARAMS='{
  "action": {"type": "String", "allowedValues": ["run", "verify", "export"]},
  "db":     {"type": "String", "default": "", "allowedPattern": "^$|^[a-z0-9_]{1,40}$"},
  "file":   {"type": "String", "default": "", "allowedPattern": "^$|^[A-Za-z0-9_.-]{1,120}[.]dump$"},
  "bucket": {"type": "String", "default": "", "allowedPattern": "^$|^ops-console-transfer-[0-9]{12}-[a-z0-9-]{1,30}$"},
  "key":    {"type": "String", "default": "", "allowedPattern": "^$|^downloads/[0-9a-f]{32}/[A-Za-z0-9_.-]{1,120}$"}
}'
upsert OpsConsole-Backups backups-list.sh "Ops Console: read-only inventory of database backups (no parameters)" 60
upsert OpsConsole-BackupAction backup-action.sh "Ops Console: run a backup, restore-test a dump into a throwaway DB, or export one for download" 600 "$BACKUP_PARAMS"
ROTATE_PARAMS='{
  "kind":   {"type": "String", "allowedValues": ["db-password", "jwt", "reload"]},
  "target": {"type": "String", "allowedPattern": "^[a-z_][a-z0-9_-]{0,30}$"}
}'
upsert OpsConsole-RotateSecret rotate-secret.sh "Ops Console: rotate a DB password or JWT secret, or reload an app's secrets, with automatic restore" 600 "$ROTATE_PARAMS"
CREATE_PARAMS='{
  "project":        {"type": "String", "allowedPattern": "^[a-z][a-z0-9-]{1,30}$"},
  "repo":           {"type": "String", "allowedPattern": "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"},
  "branch":         {"type": "String", "allowedPattern": "^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$"},
  "appSubdir":     {"type": "String", "default": "", "allowedPattern": "^$|^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$"},
  "startScript":   {"type": "String", "allowedPattern": "^[a-z0-9:_-]{1,40}$"},
  "build":          {"type": "String", "allowedValues": ["yes", "no"]},
  "migrateScript": {"type": "String", "default": "", "allowedPattern": "^$|^[a-z0-9:_-]{1,40}$"},
  "healthPath":    {"type": "String", "default": "/", "allowedPattern": "^/[A-Za-z0-9._~/-]{0,100}$"},
  "domain":         {"type": "String", "allowedPattern": "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,24}$"},
  "db":             {"type": "String", "allowedValues": ["yes", "no"]},
  "memoryMb":      {"type": "String", "default": "256", "allowedPattern": "^[0-9]{2,4}$"},
  "actor":          {"type": "String", "allowedPattern": "^[A-Za-z0-9._@:-]{1,64}$"}
}'
upsert OpsConsole-CreateApp create-app.sh "Ops Console: set up a new Node.js app from a GitHub repository and deploy it (rolls back on failure)" 1800 "$CREATE_PARAMS"
upsert OpsConsole-AppDetail app-detail.sh "Ops Console: read-only detail of one project (unit, health, git, deploys, database)" 60 "$DETAIL_PARAMS"
upsert OpsConsole-Security security-status.sh "Ops Console: read-only security snapshot (keys, SSH logins, sshd settings, OS updates; no parameters)" 180
KEYS_PARAMS='{
  "action":      {"type": "String", "allowedValues": ["add", "remove"]},
  "user":        {"type": "String", "allowedPattern": "^[a-z_][a-z0-9_-]{0,31}$"},
  "key":         {"type": "String", "default": "", "allowedPattern": "^$|^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh[.]com|sk-ecdsa-sha2-nistp256@openssh[.]com) [A-Za-z0-9+/]{40,1000}[A-Za-z0-9+/]{0,1000}={0,3}( [A-Za-z0-9@._+-]{1,100})?$"},
  "fingerprint": {"type": "String", "default": "", "allowedPattern": "^$|^SHA256:[A-Za-z0-9+/]{43}$"},
  "from":        {"type": "String", "default": "", "allowedPattern": "^$|^[0-9a-f.:/,]{1,300}$"},
  "expires":     {"type": "String", "default": "", "allowedPattern": "^$|^[0-9]{10}$"},
  "temporary":   {"type": "String", "default": "no", "allowedValues": ["yes", "no"]}
}'
upsert OpsConsole-SshKeys ssh-keys.sh "Ops Console: add or remove one public key of a login user (never root; keeps ec2-user's last key)" 60 "$KEYS_PARAMS"
