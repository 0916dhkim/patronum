#!/usr/bin/env bash
set -euo pipefail

# Called by the self_restart tool. Runs as a detached background process.
# All state lives in this process — if it dies, nothing is stale.
#
# Usage: restart.sh <source_dir> <workspace_dir> <reason> [resume_context] [chat_id]

SOURCE_DIR="$1"
WORKSPACE_DIR="$2"
REASON="$3"
RESUME_CONTEXT="${4:-}"
CHAT_ID="${5:-}"
STATE_FILE="${WORKSPACE_DIR}/.restart-state.json"

echo "[restart] Reason: ${REASON}"

# Step 1: Build
echo "[restart] Building..."
if ! (cd "${SOURCE_DIR}" && npm run build 2>&1); then
  echo "[restart] Build FAILED — aborting"
  exit 1
fi
echo "[restart] Build succeeded"

# Step 2: Write resume state (only now — build passed, restart is imminent)
if [ -n "${RESUME_CONTEXT}" ] && [ -n "${CHAT_ID}" ]; then
  python3 -c "
import json, sys
json.dump({
    'reason': sys.argv[1],
    'resumeContext': sys.argv[2],
    'chatId': sys.argv[3],
    'attempts': 0
}, open(sys.argv[4], 'w'), indent=2)
" "${REASON}" "${RESUME_CONTEXT}" "${CHAT_ID}" "${STATE_FILE}"
  echo "[restart] Resume state written"
fi

# Step 3: Restart
echo "[restart] Restarting patronum..."
sudo systemctl restart patronum

echo "[restart] Done"
