#!/usr/bin/env bash
set -euo pipefail

# Update patronum source and restart.
# Usage: sudo bash scripts/update.sh [workspace_dir]

WORKSPACE_DIR="${1:-/opt/patronum}"

echo "==> Pulling latest changes..."
cd "${WORKSPACE_DIR}/source" && git pull

echo "==> Installing dependencies and rebuilding..."
cd "${WORKSPACE_DIR}/source" && npm install && npm run build

echo "==> Restarting patronum service..."
systemctl restart patronum

echo "==> Done!"
echo "    Check status: systemctl status patronum"
echo "    View logs:    journalctl -u patronum -f"
