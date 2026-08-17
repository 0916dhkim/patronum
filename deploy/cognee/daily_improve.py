#!/usr/bin/env python3
"""
Patronum → Cognee daily improve (design doc v2, §4).

Finds chats active YESTERDAY (boundary 00:00 America/New_York), builds the
day-scoped session_ids (`chat:{chatId}:{YYYY-MM-DD}`), and runs ONE background
improve call bridging ALL of yesterday's sessions into the permanent graph +
memify enrichment. Skips empty sessions (no cache QA rows). Idempotent via the
Cognee persist watermark — repeated improve calls are cheap.

NOTE (plan delta): improve also PERSISTS TRACES + runs agent-context extraction,
which distills trace-derived agent lessons into gated agent-profile context.
Traces are written by the live write path (indexExchange → rememberTraceEntry)
and by the backfill script; the daily improve here is the consumer that turns
them into session_context that auto-recall can inject.

SECURITY: Cognee API key fetched from Vaultwarden at runtime (never on disk,
never logged). Guarded with flock so concurrent runs can't overlap. Mirrors
cognee_scheduled.sh's runtime-only secret model.

Run by systemd: cognee-daily.service → cognee-daily.timer
  (00:10 + 00:40 America/New_York; 00:40 is the catch-up for midnight-spanning turns).

Usage:
  /var/lib/patronum/cognee/.venv312/bin/python /var/lib/patronum/cognee/scripts/daily_improve.py

Exit codes: 0 = success (including non-fatal skips), 1 = fatal.
"""

import os
import sys
import json
import time
import sqlite3
import subprocess
import fcntl
from datetime import datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

# ──────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────
COGNEE_URL = "http://127.0.0.1:8001"
DATASET_NAME = "patronum_memory"
PATRONUM_DB = "/var/lib/patronum/patronum.db"
CACHE_DB = "/var/lib/patronum/cognee/.cognee_system/databases/cache.db"
LOCK_FILE = "/var/lib/patronum/cognee/.cognee_system/daily_improve.lock"
NODE = "/usr/bin/node"
VAULT_HELPER = "/var/lib/patronum/source/dist/tools/vaultwarden_helper.cjs"
WORKSPACE = "/var/lib/patronum"
NY_TZ = ZoneInfo("America/New_York")
LOG_TAG = "[daily-improve]"
# Bounded improve poll (background run) — generous, mirrors cognify poll.
POLL_TIMEOUT_S = 600
POLL_INTERVAL_S = 10
# Small margin before systemd TimeoutStartSec (900s).
REQUEST_TIMEOUT_S = 300


def log(level: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{LOG_TAG} {ts} level={level} {msg}", flush=True)


# ──────────────────────────────────────────────────────────────
# Vaultwarden: fetch Cognee API key at runtime — never persisted.
# ──────────────────────────────────────────────────────────────
def fetch_api_key() -> str | None:
    try:
        out = subprocess.run(
            [NODE, VAULT_HELPER, "Cognee API Key (Current)", "password"],
            cwd=WORKSPACE,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
        log("warn", f"msg=vaultwarden helper failed rc={out.returncode}")
    except Exception as exc:  # noqa: BLE001
        log("warn", f"msg=vaultwarden helper error err={exc}")
    return None


def auth_headers(api_key: str) -> dict:
    return {"X-Api-Key": api_key}


# ──────────────────────────────────────────────────────────────
# Yesterday's session window (America/New_York).
# Messages DB stores created_at as UTC "YYYY-MM-DD HH:MM:SS".
# ──────────────────────────────────────────────────────────────
def yesterday_window() -> tuple[str, str, str]:
    """Return (yesterday_date, utc_start, utc_end) for the NY-day of yesterday."""
    now_utc = datetime.now(timezone.utc)
    now_ny = now_utc.astimezone(NY_TZ)
    yesterday = (now_ny - timedelta(days=1)).date()
    day_start_ny = datetime.combine(yesterday, dtime.min, tzinfo=NY_TZ)
    day_end_ny = day_start_ny + timedelta(days=1)
    utc_start = day_start_ny.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = day_end_ny.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return yesterday.isoformat(), utc_start, utc_end


def find_active_chats(utc_start: str, utc_end: str) -> list[str]:
    """Chats with any message in the UTC window (converted from NY)."""
    con = sqlite3.connect(f"file:{PATRONUM_DB}?mode=ro", uri=True, timeout=10)
    try:
        rows = con.execute(
            "SELECT DISTINCT chat_id FROM messages WHERE created_at >= ? AND created_at < ?",
            (utc_start, utc_end),
        ).fetchall()
        return [r[0] for r in rows]
    finally:
        con.close()


def session_qa_count(session_id: str) -> int:
    """QA rows already in the Cognee session cache for this session."""
    if not os.path.exists(CACHE_DB):
        return 0
    con = sqlite3.connect(f"file:{CACHE_DB}?mode=ro", uri=True, timeout=10)
    try:
        row = con.execute(
            "SELECT COUNT(*) FROM cache_qa_entries WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return int(row[0]) if row else 0
    except sqlite3.Error:
        # cache.db is a backup/safety net — never fatal
        return 0
    finally:
        con.close()


# ──────────────────────────────────────────────────────────────
# Cognee REST helpers
# ──────────────────────────────────────────────────────────────
def get_dataset_id(api_key: str) -> str | None:
    r = requests.get(
        f"{COGNEE_URL}/api/v1/datasets",
        headers=auth_headers(api_key),
        timeout=REQUEST_TIMEOUT_S,
    )
    if r.status_code != 200:
        raise RuntimeError(f"GET /datasets returned {r.status_code}: {r.text[:200]}")
    for ds in r.json():
        if ds.get("name") == DATASET_NAME:
            return ds.get("id")
    return None


def ensure_dataset(api_key: str) -> str:
    """Dataset-existence guard: create if missing (idempotent — returns existing)."""
    dataset_id = get_dataset_id(api_key)
    if dataset_id:
        return dataset_id
    log("info", f"msg=dataset missing action=create dataset={DATASET_NAME}")
    r = requests.post(
        f"{COGNEE_URL}/api/v1/datasets",
        headers={**auth_headers(api_key), "Content-Type": "application/json"},
        json={"name": DATASET_NAME},
        timeout=REQUEST_TIMEOUT_S,
    )
    if r.status_code != 200:
        raise RuntimeError(f"POST /datasets returned {r.status_code}: {r.text[:200]}")
    dataset_id = r.json().get("id")
    if not dataset_id:
        raise RuntimeError("POST /datasets returned no id")
    return dataset_id


def trigger_improve(api_key: str, session_ids: list[str]) -> dict:
    """ONE improve call with all of yesterday's session_ids (background)."""
    r = requests.post(
        f"{COGNEE_URL}/api/v1/improve",
        headers={**auth_headers(api_key), "Content-Type": "application/json"},
        json={
            "dataset_name": DATASET_NAME,
            "session_ids": session_ids,
            "run_in_background": True,
        },
        timeout=REQUEST_TIMEOUT_S,
    )
    if r.status_code == 200:
        body = r.json() if r.content else {}
        # {} means a single-session improve lock was held — success-skip.
        if body == {}:
            log("warn", "msg=improve returned {} (lock held) — treating as success-skip")
            return {"status": "lock_held_skip", "skip_poll": True}
        return body
    if r.status_code in (420, 409):
        # Non-fatal: PipelineRunErrored (420) or processing error (409).
        log("warn", f"msg=improve returned non-fatal status={r.status_code} detail={r.text[:200]}")
        return {"status": f"non_fatal_{r.status_code}", "skip_poll": True}
    raise RuntimeError(f"POST /improve returned {r.status_code}: {r.text[:200]}")


def poll_dataset_status(api_key: str, dataset_id: str) -> str:
    """Poll /api/v1/datasets/status until terminal or timeout. Returns final status."""
    deadline = time.monotonic() + POLL_TIMEOUT_S
    final = "unknown"
    while True:
        try:
            r = requests.get(
                f"{COGNEE_URL}/api/v1/datasets/status",
                params={"pipeline": "memify_pipeline"},
                headers=auth_headers(api_key),
                timeout=REQUEST_TIMEOUT_S,
            )
            if r.status_code == 200:
                status_map = r.json()
                final = str(status_map.get(dataset_id, "unknown"))
        except requests.RequestException as exc:
            log("warn", f"msg=status poll failed (non-fatal) err={exc}")
        if final in ("DATASET_PROCESSING_COMPLETED", "DATASET_PROCESSING_ERRORED"):
            return final
        if time.monotonic() >= deadline:
            log("warn", f"msg=poll timeout final={final}")
            return final
        time.sleep(POLL_INTERVAL_S)


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────
def main() -> int:
    # 1. Vaultwarden key fetch (runtime only).
    api_key = fetch_api_key()
    if not api_key:
        log("warn", "msg=Cognee API key not available from Vaultwarden — skipping")
        return 0

    # 2. Health check — skip if Cognee not healthy (mirrors cognify_scheduled.sh).
    try:
        r = requests.get(f"{COGNEE_URL}/health", timeout=5)
        if r.status_code != 200 or not r.json().get("status") in ("ready", "healthy"):
            log("info", "msg=Cognee not healthy — skipping")
            return 0
    except requests.RequestException:
        log("info", "msg=Cognee not reachable — skipping")
        return 0

    # 3. flock — prevent concurrent daily-improve runs.
    try:
        lock_fd = open(LOCK_FILE, "a+")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("info", "msg=another daily-improve run in progress — skipping")
        return 0

    try:
        # 4. Yesterday's session window (UTC→NY conversion).
        yesterday, utc_start, utc_end = yesterday_window()
        log("info", f"msg=window date={yesterday} utc_start={utc_start} utc_end={utc_end}")

        # 5. Find chats active yesterday, build session_ids, skip empty sessions.
        chat_ids = find_active_chats(utc_start, utc_end)
        log("info", f"msg=active chats found count={len(chat_ids)}")

        session_ids: list[str] = []
        skipped_empty = 0
        for chat_id in chat_ids:
            sid = f"chat:{chat_id}:{yesterday}"
            qa_count = session_qa_count(sid)
            if qa_count == 0:
                skipped_empty += 1
                log("info", f"msg=session empty skipping session={sid}")
                continue
            session_ids.append(sid)
            log("info", f"msg=session queued session={sid} qa_rows={qa_count}")

        if not session_ids:
            log("info", f"msg=no non-empty sessions to improve skipped_empty={skipped_empty}")
            return 0
        log("info", f"msg=improve sessions count={len(session_ids)} skipped_empty={skipped_empty}")

        # 6. Dataset-existence guard (else create).
        dataset_id = ensure_dataset(api_key)
        log("info", f"msg=dataset ready dataset={DATASET_NAME} id={dataset_id}")

        # 7. ONE background improve call with ALL of yesterday's sessions.
        # A read-timeout on the trigger is non-fatal: the server-side improve
        # continues (watermark-idempotent) — log and proceed to poll.
        try:
            result = trigger_improve(api_key, session_ids)
        except requests.ReadTimeout:
            log("warn", "msg=improve trigger read-timeout (non-fatal) — proceeding to poll")
            result = {"status": "trigger_timeout", "skip_poll": False}
        log("info", f"msg=improve triggered status={result.get('status')}")

        # 8. Bounded poll to completion (skip when improve returned a
        # non-fatal lock/error outcome — nothing to wait for).
        if result.get("skip_poll"):
            log("info", "msg=improve returned skip_poll outcome — skipping status poll")
            return 0
        final = poll_dataset_status(api_key, dataset_id)
        if final == "DATASET_PROCESSING_COMPLETED":
            log("info", f"msg=improve completed sessions={len(session_ids)}")
        elif final == "DATASET_PROCESSING_ERRORED":
            log("warn", f"msg=improve errored (non-fatal) sessions={len(session_ids)}")
        else:
            log("warn", f"msg=improve poll inconclusive (non-fatal) final={final}")

        return 0
    except Exception as exc:  # noqa: BLE001
        log("error", f"msg=daily improve failed err={exc}")
        return 1
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            lock_fd.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
