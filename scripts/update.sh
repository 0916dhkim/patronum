#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="/home/lin/patronum"

echo "==> Pulling latest changes..."
sudo -u lin bash -c "cd ${DEPLOY_DIR} && git pull"

echo "==> Installing dependencies and rebuilding..."
sudo -u lin bash -c "cd ${DEPLOY_DIR} && npm install && npm run build"

echo "==> Restarting patronum service..."
systemctl restart patronum

echo "==> Done!"
echo "      Check status with: systemctl status patronum"
echo "      View logs with:    journalctl -u patronum -f"
