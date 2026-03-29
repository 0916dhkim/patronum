#!/usr/bin/env bash
set -euo pipefail

# Restart watcher — runs alongside patronum as a separate service.
# Watches for .restart-request.json, builds, and restarts patronum.
#
# Usage: bash scripts/restart-watcher.sh [workspace_dir]

WORKSPACE="${1:-$(pwd)}"
SOURCE_DIR="${WORKSPACE}/source"
REQUEST_FILE="${WORKSPACE}/.restart-request.json"
STATE_FILE="${WORKSPACE}/.restart-state.json"

echo "[restart-watcher] Watching ${REQUEST_FILE}"

while true; do
  # Wait for the request file to appear
  if [ ! -f "${REQUEST_FILE}" ]; then
    sleep 1
    continue
  fi

  echo "[restart-watcher] Restart requested"

  # Read and immediately remove the request file (consume-once)
  REQUEST=$(cat "${REQUEST_FILE}")
  rm -f "${REQUEST_FILE}"

  REASON=$(echo "${REQUEST}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','unknown'))" 2>/dev/null || echo "unknown")
  RESUME=$(echo "${REQUEST}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('resumeContext',''))" 2>/dev/null || echo "")
  CHAT_ID=$(echo "${REQUEST}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('chatId',''))" 2>/dev/null || echo "")

  echo "[restart-watcher] Reason: ${REASON}"

  # Step 1: Build (while the bot is still running)
  echo "[restart-watcher] Building..."
  if ! (cd "${SOURCE_DIR}" && npm run build 2>&1); then
    echo "[restart-watcher] Build FAILED — not restarting"
    # Write a failure state so the bot knows on next check
    echo "{\"error\": \"Build failed\", \"reason\": \"${REASON}\"}" > "${WORKSPACE}/.restart-failed.json"
    continue
  fi

  echo "[restart-watcher] Build succeeded"

  # Step 2: Write restart state for resume after boot
  cat > "${STATE_FILE}" << EOF
{
  "reason": $(echo "${REASON}" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))"),
  "resumeContext": $(echo "${RESUME}" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))"),
  "chatId": "${CHAT_ID}",
  "timestamp": $(date +%s)000,
  "attempts": 0
}
EOF

  # Step 3: Restart patronum
  echo "[restart-watcher] Restarting patronum service..."
  sudo systemctl restart patronum

  echo "[restart-watcher] Restart complete"
done
