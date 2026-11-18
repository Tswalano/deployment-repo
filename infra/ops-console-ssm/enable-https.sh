#!/bin/bash
# OpsConsole-EnableHttps: issue the Let's Encrypt certificate for ONE app created by the console, once its domain
# points at this server (DNS kept at another provider: the customer adds the A record after the app is created).
# Reads the domain from the app's own conf (never from the caller), checks public DNS first, then runs certbot --nginx.
# Safe to re-run: an existing certificate is reported, not replaced.
# Output (last line): {"ok":bool,"tls":bool,"domain":"…","resolves":["ip",…],"expected":"ip","reason":"…"}
set -u
export LC_ALL=C
PROJECT='{{ project }}'

out() { python3 -I -c 'import json,sys; print(json.dumps({"ok": sys.argv[1] == "1", "tls": sys.argv[2] == "1", "domain": sys.argv[3], "resolves": [x for x in sys.argv[4].split(",") if x], "expected": sys.argv[5], "reason": sys.argv[6]}))' "$@"; }
fail() { echo "ops-console: $*" >&2; exit 2; }
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "invalid project"
CONF="/opt/deploy-state/projects/$PROJECT.conf"
[[ -f "$CONF" ]] || fail "$PROJECT was not created by the console (no $CONF)"
DOMAIN="$(sed -n 's/^DOMAIN="\([a-z0-9.-]*\)".*/\1/p' "$CONF" | head -1)"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$ ]] || fail "no valid domain in $CONF"
[[ -f "/etc/nginx/conf.d/$PROJECT.conf" ]] || fail "no nginx site for $PROJECT"

IMDS_TOKEN="$(curl -s -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 120' http://169.254.169.254/latest/api/token)"
MYIP="$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)"
[[ "$MYIP" =~ ^[0-9.]+$ ]] || fail "this server has no public IPv4 address"

if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then out 1 1 "$DOMAIN" "" "$MYIP" "HTTPS is already enabled."; exit 0; fi

# public DNS as Let's Encrypt will see it (not this server's cache): ask a public resolver over HTTPS
RESOLVES="$(curl -s -m 10 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$DOMAIN&type=A" \
  | python3 -I -c 'import json,sys
try: print(",".join(a["data"] for a in json.load(sys.stdin).get("Answer", []) if a.get("type") == 1))
except Exception: print("")')"
if [[ -z "$RESOLVES" ]]; then out 0 0 "$DOMAIN" "" "$MYIP" "$DOMAIN has no A record yet. Add one pointing at $MYIP, wait a few minutes, then check again."; exit 0; fi
if [[ ",$RESOLVES," != *",$MYIP,"* || "$RESOLVES" == *,* ]]; then
  out 0 0 "$DOMAIN" "$RESOLVES" "$MYIP" "$DOMAIN points at $RESOLVES. Change its A record to $MYIP only, wait a few minutes, then check again."; exit 0
fi

if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --register-unsafely-without-email >/tmp/opshttps.log 2>&1; then
  out 1 1 "$DOMAIN" "$RESOLVES" "$MYIP" "HTTPS enabled for $DOMAIN."
else
  out 0 0 "$DOMAIN" "$RESOLVES" "$MYIP" "Let's Encrypt refused the certificate: $(grep -m1 -iE 'detail|error' /tmp/opshttps.log | cut -c1-200 | tr -d '"\\')"
fi
