#!/usr/bin/env python3
"""
Patronum → Cognee session backfill (design doc v2, §5).

Rebuilds the graph from the per-day session model:
  1. forget `patronum_memory`
  2. recreate the dataset (POST /api/v1/datasets)
  3. for each (chat_id, NY-date) day, oldest-first:
       - if the session already has rows in cache_qa_entries → skip (dedup)
       - else write QA entries (user → assistant reply pairs) for that day
       - then write per-tool-call trace entries (build_trace_steps) so improve
         can distill agent lessons — traces ride the same QA-rows cache gate
       - then improve that day (background + await dataset status)
  4. resumable via a checkpoint file keyed by session_id

The primary dedup is the cache/session + checkpoint check, NOT content-hash
dedup (cache duplicates defeat it).

SECURITY: Cognee API key fetched from Vaultwarden at runtime — never on disk.

SAFETY: defaults to DRY-RUN. Pass --execute to actually forget/recreate/write.
Use --yes-i-understand-forget to acknowledge the destructive forget step.

Usage:
  # dry run (prints plan, touches nothing)
  /var/lib/patronum/cognee/.venv312/bin/python scripts/backfill_sessions.py
  # real run
  /var/lib/patronum/cognee/.venv312/bin/python scripts/backfill_sessions.py --execute --yes-i-understand-forget
"""

import os
import sys
import json
import time
import sqlite3
import subprocess
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
CHECKPOINT_FILE = "/var/lib/patronum/cognee/.cognee_system/backfill_sessions.checkpoint"
NODE = "/usr/bin/node"
VAULT_HELPER = "/var/lib/patronum/source/dist/tools/vaultwarden_helper.cjs"
WORKSPACE = "/var/lib/patronum"
NY_TZ = ZoneInfo("America/New_York")
REQUEST_TIMEOUT_S = 30
POLL_TIMEOUT_S = 600
POLL_INTERVAL_S = 10

# Messages older than this are out of scope (dataset was created ~2026-07-21).
MIN_DATE = "2026-01-01"

# Trace step caps (mirror recall.cognee.ts collectTraceSteps).
TRACE_PARAMS_MAX = 1000
TRACE_RETURN_MAX = 2000


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[backfill-sessions] {ts} {msg}", flush=True)


# ──────────────────────────────────────────────────────────────
# Vaultwarden key fetch (runtime only)
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
        log(f"WARN vaultwarden helper failed rc={out.returncode}")
    except Exception as exc:  # noqa: BLE001
        log(f"WARN vaultwarden helper error err={exc}")
    return None


def auth_headers(api_key: str) -> dict:
    return {"X-Api-Key": api_key}


# ──────────────────────────────────────────────────────────────
# Message parsing
# ──────────────────────────────────────────────────────────────
def extract_text(content_json: str) -> str:
    try:
        content = json.loads(content_json)
    except Exception:  # noqa: BLE001
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(parts)
    return ""


def is_user_text_message(content_json: str) -> bool:
    """A user message that is a real question (not a tool_result)."""
    try:
        content = json.loads(content_json)
    except Exception:  # noqa: BLE001
        return False
    if isinstance(content, str):
        stripped = content.strip()
        if not stripped:
            return False
        # Synthetic bot-injected events (agent_completion/agent_failure/
        # restart-resume) are stored with role "user" but are NOT real user
        # questions — exclude them from backfilled QA pairs.
        if stripped.startswith("[system]"):
            return False
        return True
    if isinstance(content, list):
        return not any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        )
    return False


def ny_date_of(utc_str: str):
    """Convert a UTC 'YYYY-MM-DD HH:MM:SS' DB string to an America/New_York date."""
    try:
        dt = datetime.strptime(utc_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return dt.astimezone(NY_TZ).date()


def load_day_buckets() -> dict:
    """
    Group messages into (chat_id, NY-date) buckets, oldest-first within each day.
    Returns dict[(chat_id, ny_date)] -> list of (role, content_json, id).
    """
    con = sqlite3.connect(f"file:{PATRONUM_DB}?mode=ro", uri=True, timeout=10)
    buckets: dict = {}
    try:
        rows = con.execute(
            "SELECT id, chat_id, role, content_json, created_at FROM messages "
            "WHERE created_at >= ? ORDER BY id ASC",
            (MIN_DATE,),
        ).fetchall()
    finally:
        con.close()

    for mid, chat_id, role, content_json, created_at in rows:
        d = ny_date_of(created_at)
        if d is None:
            continue
        buckets.setdefault((chat_id, d.isoformat()), []).append((role, content_json, mid))
    return buckets


def build_qa_pairs(messages) -> list[tuple[str, str]]:
    """Extract (question, answer) pairs from a day's messages, in order."""
    pairs: list[tuple[str, str]] = []
    pending_question = None
    for role, content_json, _mid in messages:
        if role == "user" and is_user_text_message(content_json):
            q = extract_text(content_json).strip()
            # Photo-only messages (image block, no text) yield "" — never pair
            # an empty question with an answer.
            pending_question = q if q else None
        elif role == "assistant" and pending_question is not None:
            answer = extract_text(content_json).strip()
            if answer:
                pairs.append((pending_question, answer))
                pending_question = None
    return pairs


def stringify_tool_content(content) -> str:
    """Stringify a tool_result content payload (string | list of blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = [
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        if text_parts:
            return "\n".join(text_parts)
        # No text blocks — JSON-stringify any remaining (non-text) blocks.
        non_text = [b for b in content if not (isinstance(b, dict) and b.get("type") == "text")]
        if not non_text:
            return ""  # truly empty — no content at all
        try:
            return json.dumps(content)
        except Exception:  # noqa: BLE001
            return ""
    return ""


def build_trace_steps(messages) -> list[dict]:
    """Extract TraceEntry steps from a day's messages (mirrors TS collectTraceSteps).

    Parses content_json JSON blocks, pairs each assistant tool_use with its
    tool_result (found in user-role messages by tool_use_id). Same caps /
    redaction / orphan-skip as the TS helper: method_params stays a dict (Cognee's
    TraceEntry rejects stringified JSON with 422), oversized params →
    {"truncated": true, "preview": <stringified slice>}; the vaultwarden
    (secrets) tool is redacted; orphaned tool_use blocks and entries with no
    content are skipped.
    """
    results: dict = {}
    for role, content_json, _mid in messages:
        if role != "user":
            continue
        try:
            content = json.loads(content_json)
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                results[block.get("tool_use_id")] = block

    steps: list[dict] = []
    for role, content_json, _mid in messages:
        if role != "assistant":
            continue
        try:
            content = json.loads(content_json)
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            tool_use_id = block.get("id")
            result = results.get(tool_use_id)
            if result is None:
                continue  # orphaned — skip
            is_error = bool(result.get("is_error"))
            origin_function = block.get("name") or ""
            if not origin_function:
                continue

            if origin_function == "vaultwarden":
                method_params = {"redacted": True}
                method_return_value = "[redacted — secrets tool]"
                error_message = "[redacted — secrets tool]" if is_error else ""
            else:
                raw_params = block.get("input") or {}
                raw_params_json = json.dumps(raw_params, ensure_ascii=False)
                if len(raw_params_json) <= TRACE_PARAMS_MAX:
                    method_params = raw_params
                else:
                    method_params = {"truncated": True, "preview": raw_params_json[:TRACE_PARAMS_MAX]}
                raw_return = stringify_tool_content(result.get("content"))
                method_return_value = (
                    raw_return[:TRACE_RETURN_MAX]
                    if len(raw_return) > TRACE_RETURN_MAX
                    else raw_return
                )
                error_message = method_return_value if is_error else ""

            if not method_return_value.strip():
                continue  # no content at all — skip
            steps.append({
                "type": "trace",
                "origin_function": origin_function,
                "status": "error" if is_error else "success",
                "method_params": method_params,
                "method_return_value": method_return_value,
                "error_message": error_message,
                "generate_feedback_with_llm": False,
            })
    return steps


# ──────────────────────────────────────────────────────────────
# Cognee REST helpers
# ──────────────────────────────────────────────────────────────
def http_json(method: str, path: str, api_key: str, **kw):
    url = f"{COGNEE_URL}{path}"
    headers = auth_headers(api_key)
    if "headers" in kw:
        kw["headers"] = {**headers, **kw["headers"]}
    else:
        kw["headers"] = headers
    kw.setdefault("timeout", REQUEST_TIMEOUT_S)
    r = requests.request(method, url, **kw)
    return r


def get_dataset_id(api_key: str) -> str | None:
    r = http_json("GET", "/api/v1/datasets", api_key)
    if r.status_code != 200:
        raise RuntimeError(f"GET /datasets -> {r.status_code}: {r.text[:200]}")
    for ds in r.json():
        if ds.get("name") == DATASET_NAME:
            return ds.get("id")
    return None


def forget_dataset(api_key: str) -> None:
    r = http_json(
        "POST", "/api/v1/forget", api_key,
        headers={"Content-Type": "application/json"},
        json={"dataset": DATASET_NAME},
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(f"POST /forget -> {r.status_code}: {r.text[:200]}")


def recreate_dataset(api_key: str) -> str:
    r = http_json(
        "POST", "/api/v1/datasets", api_key,
        headers={"Content-Type": "application/json"},
        json={"name": DATASET_NAME},
    )
    if r.status_code != 200:
        raise RuntimeError(f"POST /datasets -> {r.status_code}: {r.text[:200]}")
    return r.json().get("id")


def write_qa_entry(api_key: str, session_id: str, question: str, answer: str) -> bool:
    r = http_json(
        "POST", "/api/v1/remember/entry", api_key,
        headers={"Content-Type": "application/json"},
        json={
            "entry": {"type": "qa", "question": question, "answer": answer},
            "dataset_name": DATASET_NAME,
            "session_id": session_id,
        },
    )
    if r.status_code == 200:
        return True
    # 400 (missing session_id etc.) / 409 are logged; a single bad QA shouldn't
    # abort the whole day — caller decides via the boolean.
    log(f"WARN remember/entry -> {r.status_code} session={session_id} detail={r.text[:200]}")
    return False


def write_trace_entry(api_key: str, session_id: str, step: dict) -> bool:
    """POST one TraceEntry (built by build_trace_steps) to the session cache."""
    r = http_json(
        "POST", "/api/v1/remember/entry", api_key,
        headers={"Content-Type": "application/json"},
        json={
            "entry": step,
            "dataset_name": DATASET_NAME,
            "session_id": session_id,
        },
    )
    if r.status_code == 200:
        return True
    # Same fail-open posture as QA: a single bad trace step shouldn't abort the day.
    log(f"WARN remember/entry (trace) -> {r.status_code} session={session_id} detail={r.text[:200]}")
    return False


def trigger_improve(api_key: str, session_id: str) -> str:
    """Trigger a background improve for one session.

    Returns one of:
      - "lock_held": single-session lock held by another improve that is
        processing this very session — safe to checkpoint (it owns the work).
      - "error": non-fatal 420/409 outcome — do NOT checkpoint (a 409 can
        precede persist completion); retry on a later run.
      - "ok": improve queued. Poll, and only checkpoint on COMPLETED.
      - "timeout": trigger read-timed out; server-side state unknown. Poll, and
        only checkpoint on COMPLETED.
    """
    try:
        r = http_json(
            "POST", "/api/v1/improve", api_key,
            headers={"Content-Type": "application/json"},
            json={
                "dataset_name": DATASET_NAME,
                "session_ids": [session_id],
                "run_in_background": True,
            },
            timeout=300,
        )
    except requests.ReadTimeout:
        log(f"WARN improve trigger read-timeout (non-fatal) session={session_id} — proceeding to poll")
        return "timeout"
    if r.status_code == 200 and r.json() == {}:
        # Single-session lock held — success-skip (another improve owns it).
        log(f"INFO improve returned {{}} (lock held) session={session_id} — success-skip")
        return "lock_held"
    if r.status_code in (420, 409):
        log(f"WARN improve non-fatal status={r.status_code} session={session_id}")
        return "error"
    if r.status_code != 200:
        raise RuntimeError(f"POST /improve -> {r.status_code}: {r.text[:200]}")
    log(f"INFO improve triggered session={session_id}")
    return "ok"


def poll_dataset_status(api_key: str, dataset_id: str) -> str:
    deadline = time.monotonic() + POLL_TIMEOUT_S
    final = "unknown"
    while True:
        try:
            r = http_json("GET", "/api/v1/datasets/status", api_key, params={"pipeline": "memify_pipeline"})
            if r.status_code == 200:
                final = str(r.json().get(dataset_id, "unknown"))
        except requests.RequestException as exc:
            log(f"WARN status poll failed (non-fatal) err={exc}")
        if final in ("DATASET_PROCESSING_COMPLETED", "DATASET_PROCESSING_ERRORED"):
            return final
        if time.monotonic() >= deadline:
            return final
        time.sleep(POLL_INTERVAL_S)


# ──────────────────────────────────────────────────────────────
# Checkpoint / cache dedup
# ──────────────────────────────────────────────────────────────
def load_checkpoint() -> set:
    if not os.path.exists(CHECKPOINT_FILE):
        return set()
    with open(CHECKPOINT_FILE, "r", encoding="utf-8") as f:
        return set(line.strip() for line in f if line.strip())


def save_checkpoint(session_id: str) -> None:
    os.makedirs(os.path.dirname(CHECKPOINT_FILE), exist_ok=True)
    with open(CHECKPOINT_FILE, "a", encoding="utf-8") as f:
        f.write(session_id + "\n")


def session_qa_cache_count(session_id: str) -> int:
    """Count NON-EXPIRED QA cache rows for a session (0 on any error / no cache)."""
    if not os.path.exists(CACHE_DB):
        return 0
    con = sqlite3.connect(f"file:{CACHE_DB}?mode=ro", uri=True, timeout=10)
    try:
        row = con.execute(
            "SELECT COUNT(*) FROM cache_qa_entries WHERE session_id = ? "
            "AND (expires_at IS NULL OR expires_at > datetime('now'))",
            (session_id,),
        ).fetchone()
        return int(row[0]) if row else 0
    except sqlite3.Error:
        return 0
    finally:
        con.close()


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────
def main() -> int:
    execute = "--execute" in sys.argv
    confirm_forget = "--yes-i-understand-forget" in sys.argv
    if execute and not confirm_forget:
        log("ERROR --execute requires --yes-i-understand-forget (destructive forget step)")
        return 1

    api_key = fetch_api_key()
    if not api_key:
        log("ERROR Cognee API key not available from Vaultwarden")
        return 1

    buckets = load_day_buckets()
    # Oldest-first by (chat_id, ny_date).
    keys = sorted(buckets.keys(), key=lambda k: (k[1], k[0]))
    log(f"INFO found {len(keys)} (chat, day) buckets from patronum.db")

    done = load_checkpoint()

    # 1. Plan: classify every not-yet-done session into one of:
    #   - pending_write: no cache rows, QA pairs to write (fresh work)
    #   - recover:       complete cache rows but not checkpointed (improve-only)
    #   - blocked:       partial cache rows (0 < rows < expected) — leave visible
    #   - no_pairs:      no cache rows and no QA pairs (nothing to write)
    pending_write: list[tuple[str, int, int]] = []
    recover: list[str] = []
    blocked: list[tuple[str, int, int]] = []
    no_pairs: list[str] = []
    for chat_id, ny_date in keys:
        session_id = f"chat:{chat_id}:{ny_date}"
        if session_id in done:
            continue
        pairs = build_qa_pairs(buckets[(chat_id, ny_date)])
        rows = session_qa_cache_count(session_id)
        if rows > 0:
            expected = len(pairs)
            if expected == 0 or rows >= expected:
                recover.append(session_id)
            else:
                blocked.append((session_id, rows, expected))
            continue
        if not pairs:
            no_pairs.append(session_id)
            continue
        steps = build_trace_steps(buckets[(chat_id, ny_date)])
        pending_write.append((session_id, len(pairs), len(steps)))

    log(f"INFO plan: pending_write={len(pending_write)} recover={len(recover)} "
        f"blocked={len(blocked)} no_pairs={len(no_pairs)} done={len(done)}")
    for session_id, n, t in pending_write[:200]:
        log(f"PLAN write+improve session={session_id} qa_pairs={n} trace_steps={t}")
    for session_id in recover[:200]:
        log(f"PLAN improve-only (cache rows complete) session={session_id}")

    if not execute:
        return 0

    # Blocked sessions are visible every run and must be resolved by hand —
    # never silently improve/checkpoint partial rows.
    if blocked:
        for session_id, rows, expected in blocked:
            log(f"ERROR partial cache rows session={session_id} rows={rows} expected={expected} — refusing to proceed")
        return 1

    if not pending_write and not recover:
        log("INFO nothing to do (no pending writes, no recoverable sessions)")
        for session_id in no_pairs:
            save_checkpoint(session_id)
            log(f"INFO checkpoint (no QA pairs) session={session_id}")
        return 0

    # 2. Dataset: forget+recreate ONLY on a fresh rebuild (no checkpoint yet).
    # On resume runs the dataset already exists and was rebuilt in run 1 —
    # forgetting again would destroy the already-persisted sessions.
    if pending_write and not done:
        log(f"INFO first run — forget dataset={DATASET_NAME}")
        forget_dataset(api_key)
        log("INFO recreating dataset")
        dataset_id = recreate_dataset(api_key)
        log(f"INFO dataset recreated id={dataset_id}")
    else:
        dataset_id = get_dataset_id(api_key) or recreate_dataset(api_key)
        log(f"INFO dataset ready id={dataset_id}")

    # 3. Per-day, oldest-first: write QAs + traces, then improve.
    for chat_id, ny_date in keys:
        session_id = f"chat:{chat_id}:{ny_date}"
        if session_id in done:
            continue

        pairs = build_qa_pairs(buckets[(chat_id, ny_date)])
        rows = session_qa_cache_count(session_id)

        if rows > 0 and not (not pairs or rows >= len(pairs)):
            # Race: rows appeared mid-run but are fewer than the expected QA
            # pairs (e.g. live writes started, or a partial earlier run).
            # Never write over them or checkpoint a partial — skip, retry later.
            log(f"WARN partial cache rows in-loop rows={rows} expected={len(pairs)} — skipping session={session_id}")
            continue

        if rows > 0 and (not pairs or rows >= len(pairs)):
            # Complete cache rows (recover): skip writes, improve + checkpoint.
            log(f"INFO cache rows complete — improve+checkpoint session={session_id}")
            outcome = trigger_improve(api_key, session_id)
            if outcome == "lock_held":
                save_checkpoint(session_id)
                log(f"INFO improve lock held — checkpoint session={session_id}")
            elif outcome == "error":
                log(f"WARN improve error outcome — NOT checkpointing session={session_id}")
            else:
                final = poll_dataset_status(api_key, dataset_id)
                log(f"INFO improve final={final} session={session_id}")
                if final == "DATASET_PROCESSING_COMPLETED":
                    save_checkpoint(session_id)
                else:
                    log(f"WARN improve inconclusive — NOT checkpointing session={session_id}")
            continue

        if not pairs:
            save_checkpoint(session_id)
            log(f"INFO checkpoint (no QA pairs) session={session_id}")
            continue

        written = 0
        for question, answer in pairs:
            if write_qa_entry(api_key, session_id, question, answer):
                written += 1
        log(f"INFO wrote {written}/{len(pairs)} QA entries session={session_id}")

        if written == 0:
            log(f"WARN all QA writes failed session={session_id} — not checkpointing")
            continue
        if written < len(pairs):
            log(f"WARN partial QA write {written}/{len(pairs)} session={session_id} — not checkpointing")
            continue

        trace_steps = build_trace_steps(buckets[(chat_id, ny_date)])
        trace_written = 0
        for step in trace_steps:
            if write_trace_entry(api_key, session_id, step):
                trace_written += 1
        log(f"INFO wrote {trace_written}/{len(trace_steps)} trace entries session={session_id}")

        outcome = trigger_improve(api_key, session_id)
        if outcome == "lock_held":
            save_checkpoint(session_id)
            log(f"INFO improve lock held — checkpoint session={session_id}")
        elif outcome == "error":
            log(f"WARN improve error outcome — NOT checkpointing session={session_id}")
        else:
            final = poll_dataset_status(api_key, dataset_id)
            log(f"INFO improve final={final} session={session_id}")
            if final == "DATASET_PROCESSING_COMPLETED":
                save_checkpoint(session_id)
            else:
                log(f"WARN improve inconclusive — NOT checkpointing session={session_id}")

    log("INFO backfill complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
