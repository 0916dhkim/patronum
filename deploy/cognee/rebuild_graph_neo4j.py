#!/usr/bin/env python3
"""
Kuzu -> Neo4j graph rebuild for Patronum memory.

The graph provider has been switched from Kuzu/Ladybug to Neo4j. The graph,
vector, and relational layers for `patronum_memory` must be rebuilt on the new
backend. The session cache (cache_qa_entries / cache_trace_entries) already
holds the complete per-day session content, so this script does NOT re-derive
anything from patronum.db — it:

  1. forgets `patronum_memory` (graph + vector + relational only; the session
     cache survives Cognee's _forget_dataset semantics)
  2. recreates the dataset
  3. resets the per-session persist watermarks (otherwise improve() would think
     everything was already persisted and rebuild nothing)
  4. for each session present in the cache, runs one background improve() and
     polls until DATASET_PROCESSING_COMPLETED.

Resumable via a rebuild checkpoint file. Dry-run by default.

SAFETY: Pass --execute to actually forget/recreate/improve.
Usage:
  # dry run (prints plan, touches nothing)
  /var/lib/patronum/cognee/.venv312/bin/python deploy/cognee/rebuild_graph_neo4j.py
  # real run
  /var/lib/patronum/cognee/.venv312/bin/python deploy/cognee/rebuild_graph_neo4j.py --execute
"""

import os
import sys
import sqlite3
import time

# Reuse the battle-tested REST helpers and constants from the backfill script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backfill_sessions as bf  # noqa: E402

from backfill_sessions import (  # noqa: E402
    COGNEE_URL,
    DATASET_NAME,
    CACHE_DB,
    fetch_api_key,
    get_dataset_id,
    forget_dataset,
    recreate_dataset,
    trigger_improve,
    poll_dataset_status,
    log,
)

# Rebuild sessions are much larger than a day-scoped improve (hundreds of
# trace steps each); extend the poll window per session to 90 minutes.
bf.POLL_TIMEOUT_S = 5400

CHECKPOINT_FILE = "/var/lib/patronum/cognee/.cognee_system/rebuild_graph_neo4j.checkpoint"

# Sessions are keyed by user_id+session_id in the cache. The default user is
# patronum@localhost.localdomain; resolve its id from the cache rows at runtime
# rather than hardcoding.
SESSION_LIKE = "chat:%"


def cache_sessions() -> list[str]:
    """Return chat sessions present in the QA cache, oldest-first."""
    if not os.path.exists(CACHE_DB):
        return []
    con = sqlite3.connect(f"file:{CACHE_DB}?mode=ro", uri=True, timeout=10)
    try:
        rows = con.execute(
            "SELECT DISTINCT session_id FROM cache_qa_entries "
            "WHERE session_id LIKE ? ORDER BY session_id ASC",
            (SESSION_LIKE,),
        ).fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


def reset_persist_watermarks(session_ids: list[str]) -> None:
    """Delete session-persist watermark rows so improve() re-persists from scratch."""
    con = sqlite3.connect(CACHE_DB, timeout=30)
    try:
        qmarks = ",".join("?" for _ in session_ids)
        cur = con.execute(
            f"DELETE FROM cache_session_context "
            f"WHERE session_id IN ({qmarks}) AND entry_id = 'session_persist_watermark'",
            session_ids,
        )
        con.commit()
        log(f"INFO reset {cur.rowcount} persist watermark(s) for {len(session_ids)} sessions")
    finally:
        con.close()


def load_checkpoint() -> set:
    if not os.path.exists(CHECKPOINT_FILE):
        return set()
    with open(CHECKPOINT_FILE, "r", encoding="utf-8") as f:
        return set(line.strip() for line in f if line.strip())


def save_checkpoint(session_id: str) -> None:
    os.makedirs(os.path.dirname(CHECKPOINT_FILE), exist_ok=True)
    with open(CHECKPOINT_FILE, "a", encoding="utf-8") as f:
        f.write(session_id + "\n")


def main() -> int:
    execute = "--execute" in sys.argv

    sessions = cache_sessions()
    if not sessions:
        log("ERROR no chat sessions found in cache — nothing to rebuild")
        return 1

    done = load_checkpoint()
    pending = [s for s in sessions if s not in done]

    log(f"INFO cache sessions={len(sessions)} done={len(done)} pending={len(pending)}")
    for s in sessions:
        state = "DONE" if s in done else "PENDING"
        log(f"PLAN session={s} state={state}")

    if not execute:
        log("INFO dry run complete — pass --execute to run")
        return 0

    if not pending:
        log("INFO nothing to do — all sessions rebuilt")
        return 0

    api_key = fetch_api_key()
    if not api_key:
        log("ERROR Cognee API key not available from Vaultwarden")
        return 1

    # 1. Forget + recreate only on a fresh rebuild (no checkpoint yet).
    if not done:
        log(f"INFO first run — forget dataset={DATASET_NAME}")
        forget_dataset(api_key)
        log("INFO recreating dataset")
        dataset_id = recreate_dataset(api_key)
        log(f"INFO dataset recreated id={dataset_id}")
        reset_persist_watermarks(sessions)
    else:
        dataset_id = get_dataset_id(api_key) or recreate_dataset(api_key)
        log(f"INFO dataset ready id={dataset_id}")

    # 2. Per-session improve, oldest-first.
    for session_id in sessions:
        if session_id in done:
            continue
        outcome = trigger_improve(api_key, session_id)
        if outcome == "lock_held":
            save_checkpoint(session_id)
            log(f"INFO improve lock held — checkpoint session={session_id}")
            continue
        if outcome == "error":
            log(f"WARN improve error outcome — NOT checkpointing session={session_id}")
            continue
        final = poll_dataset_status(api_key, dataset_id)
        log(f"INFO improve final={final} session={session_id}")
        if final == "DATASET_PROCESSING_COMPLETED":
            save_checkpoint(session_id)
        else:
            log(f"WARN improve inconclusive — NOT checkpointing session={session_id}")

    remaining = [s for s in sessions if s not in load_checkpoint()]
    log(f"INFO rebuild pass finished — remaining={len(remaining)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
