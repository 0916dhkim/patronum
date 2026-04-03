#!/usr/bin/env bash
set -euo pipefail

# Install patronum as a systemd service.
# Usage: sudo bash scripts/install.sh [workspace_dir] [user]
#
# Defaults:
#   workspace_dir: /opt/patronum
#   user: patronum

WORKSPACE_DIR="${1:-/opt/patronum}"
SERVICE_USER="${2:-patronum}"

echo "==> Installing patronum"
echo "    Workspace: ${WORKSPACE_DIR}"
echo "    User: ${SERVICE_USER}"

# Create user if needed
if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --home-dir "${WORKSPACE_DIR}" --shell /bin/bash "${SERVICE_USER}"
  echo "    Created user: ${SERVICE_USER}"
fi

# Create workspace
mkdir -p "${WORKSPACE_DIR}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${WORKSPACE_DIR}"

# Clone source if not present
if [ ! -d "${WORKSPACE_DIR}/source" ]; then
  echo "==> Cloning source..."
  sudo -u "${SERVICE_USER}" git clone "$(git remote get-url origin)" "${WORKSPACE_DIR}/source"
fi

# Install and build
echo "==> Installing dependencies and building..."
sudo -u "${SERVICE_USER}" bash -c "cd ${WORKSPACE_DIR}/source && npm install && npm run build"

# Install systemd service
cat > /etc/systemd/system/patronum.service << EOF
[Unit]
Description=Patronum AI Agent
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${WORKSPACE_DIR}
ExecStart=/usr/bin/node ${WORKSPACE_DIR}/source/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable patronum

echo ""
echo "==> Installed! Next steps:"
echo "    1. Create ${WORKSPACE_DIR}/patronum.toml with your config and credentials"
echo "    2. systemctl start patronum"
echo "    3. journalctl -u patronum -f"
