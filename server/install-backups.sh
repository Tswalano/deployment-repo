#!/usr/bin/env bash
# install-backups.sh: installs the nightly backup timer and runs one backup now. Idempotent.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sudo install -d -m 0700 -o ec2-user -g ec2-user /var/backups/app-db
sudo install -m 0644 "$ROOT/systemd/db-backup.service" /etc/systemd/system/db-backup.service
sudo install -m 0644 "$ROOT/systemd/db-backup.timer" /etc/systemd/system/db-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now db-backup.timer
echo "→ running a first backup now"
sudo systemctl start db-backup.service && sudo journalctl -u db-backup.service -n 10 --no-pager -o cat
systemctl list-timers db-backup.timer --no-pager | head -2
