#!/usr/bin/env bash
# =============================================================================
# load-app-secrets <service>
#
# Installed on the server as /usr/local/bin/load-app-secrets and run by systemd
# as root (ExecStartPre=+...) before each app starts. Fetches every parameter
# under /apps/<service>/ from SSM Parameter Store (SecureStrings are decrypted
# with the instance role) and writes them to
#     /run/app-secrets/<service>.env        (tmpfs, root:root 0600)
# which the unit reads via EnvironmentFile=. Nothing is written to disk.
#
# Parameter /apps/liftparcel/JWT_SECRET  →  JWT_SECRET="..."
# =============================================================================
set -Eeuo pipefail
svc="${1:?usage: load-app-secrets <service>}"
[[ "$svc" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad service name" >&2; exit 2; }
region="${AWS_REGION:-af-south-1}"
prefix="${SECRETS_PREFIX:-/apps}/$svc/"
dir=/run/app-secrets
out="$dir/$svc.env"

install -d -m 0700 -o root -g root "$dir"
tmp="$(mktemp "$dir/.$svc.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# Retry: at boot the network/IMDS can take a few seconds to come up
for attempt in 1 2 3 4 5; do
  if json="$(aws ssm get-parameters-by-path --region "$region" --path "$prefix" \
               --recursive --with-decryption --output json 2>/tmp/load-app-secrets.err)"; then
    break
  fi
  echo "load-app-secrets[$svc]: attempt $attempt failed: $(head -1 /tmp/load-app-secrets.err)" >&2
  [[ $attempt == 5 ]] && exit 1
  sleep $((attempt * 3))
done

# Render as systemd EnvironmentFile: KEY="value" with \ and " escaped
printf '%s' "$json" | python3 -I -c '
import sys, json, re
prefix = sys.argv[1]
params = json.load(sys.stdin)["Parameters"]
if not params:
    sys.exit("no parameters found under " + prefix)
for p in sorted(params, key=lambda p: p["Name"]):
    key = p["Name"][len(prefix):]
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        print("skipping invalid env name: " + key, file=sys.stderr); continue
    val = p["Value"].replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
    print(f"{key}=\"{val}\"")
' "$prefix" > "$tmp"

chmod 0600 "$tmp"
mv -f "$tmp" "$out"
trap - EXIT
echo "load-app-secrets[$svc]: loaded $(wc -l < "$out") variables from $prefix"
