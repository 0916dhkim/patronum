#!/usr/bin/env bash
set -euo pipefail

REPO_SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="/home/lin/patronum"
SERVICE_FILE="patronum.service"

echo "==> Copying repo to ${DEPLOY_DIR}..."
rsync -a --exclude node_modules --exclude .git --exclude .env "$REPO_SRC/" "$DEPLOY_DIR/"

echo "==> Setting ownership to lin:lin..."
chown -R lin:lin "$DEPLOY_DIR"

echo "==> Installing dependencies and building..."
sudo -u lin bash -c "cd ${DEPLOY_DIR} && npm install && npm run build"

echo "==> Installing systemd service..."
cp "${DEPLOY_DIR}/${SERVICE_FILE}" /etc/systemd/system/
systemctl daemon-reload
systemctl enable patronum
systemctl start patronum

echo "==> Done!"
echo ""
echo "NOTE: Make sure /home/lin/patronum/.env exists with your config."
echo "      Check status with: systemctl status patronum"
echo "      View logs with:    journalctl -u patronum -f"
