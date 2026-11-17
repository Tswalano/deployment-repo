#!/usr/bin/env bash
# Build the server release bundle that OpsConsole-PrepareServer installs on customer servers (Phase 12b-2):
# server/, systemd/, ops-dashboard/ and templates/ as a reproducible tarball (fixed order, owner and times), so the
# same source always gives the same SHA-256. Prints the file and its checksum.
#   ./infra/saas/build-bundle.sh            # → dist/bundles/<sha256>.tar.gz
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
OUT=dist/bundles; mkdir -p "$OUT"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
tar --sort=name --mtime='2020-01-01 00:00:00Z' --owner=0 --group=0 --numeric-owner --exclude='__pycache__' --exclude='*.pyc' \
    -cf - server systemd ops-dashboard templates | gzip -n -9 > "$TMP"
SHA="$(sha256sum "$TMP" | cut -d' ' -f1)"
mv "$TMP" "$OUT/$SHA.tar.gz"; trap - EXIT
echo "$OUT/$SHA.tar.gz"
echo "SERVER_BUNDLE_SHA256=$SHA"
