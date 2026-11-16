#!/usr/bin/env bash
# Create/update the Ops Console's SSM documents in a region (run once per region with managed instances).
#   ./infra/ops-console-ssm/deploy.sh [region]
# Documents are fixed scripts: the console can run THESE and nothing else (see infra/iam/instance-ops-console.json).
set -Eeuo pipefail
cd "$(dirname "$0")"
REGION="${1:-${AWS_REGION:-af-south-1}}"

doc_json() { # doc_json <script-file> <description>
  python3 -I - "$1" "$2" <<'PY'
import json, sys
lines = open(sys.argv[1]).read().splitlines()
print(json.dumps({
  "schemaVersion": "2.2",
  "description": sys.argv[2],
  "mainSteps": [{"action": "aws:runShellScript", "name": "run",
                 "inputs": {"timeoutSeconds": "60", "runCommand": lines}}],
}))
PY
}

upsert() { # upsert <name> <script> <description>
  local name=$1 content; content="$(doc_json "$2" "$3")"
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

echo "→ SSM documents in $REGION"
upsert OpsConsole-CollectStatus collect-status.sh "Ops Console: read-only status snapshot (no parameters)"
