#!/usr/bin/env python3
"""
Run the lesson pipeline over existing sessions WITHOUT re-ingesting.

After AUTO_FEEDBACK is enabled, improve() runs agent-context extraction
(trace -> gated guidance) and distillation (guidance + QA -> session_learnings).
The session cache already holds the QA + trace rows, and the persist
watermarks are already advanced, so this only needs to re-run improve() per
session — no forget, no re-write, no duplicate Q&A persistence.

Usage:
  # dry run
  /var/lib/patronum/cognee/.venv312/bin/python deploy/cognee/extract_session_lessons.py
  # real run
  /var/lib/patronum/cognee/.venv312/bin/python deploy/cognee/extract_session_lessons.py --execute
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backfill_sessions import (  # noqa: E402
    CACHE_DB,
    fetch_api_key,
    get_dataset_id,
    recreate_dataset,
    trigger_improve,
    poll_dataset_status,
    log,
)

# Lesson extraction reads the latest BATCH_TRACE_LIMIT traces per session and
# distills; the whole pass is LLM-bound but bounded. Generous poll window.
import backfill_sessions as bf  # noqa: E402

bf.POLL_TIMEOUT_S = 5400


def cache_sessions() -> list[str]:
    if not os.path.exists(CACHE_DB):
        return []
    con = sqlite3.connect(f"file:{CACHE_DB}?mode=ro", uri=True, timeout=10)
    try:
        rows = con.execute(
            "SELECT DISTINCT session_id FROM cache_qa_entries "
            "WHERE session_id LIKE 'chat:%' ORDER BY session_id ASC"
        ).fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


def main() -> int:
    execute = "--execute" in sys.argv

    sessions = cache_sessions()
    if not sessions:
        log("ERROR no chat sessions in cache")
        return 1

    log(f"INFO sessions={len(sessions)}")
    for s in sessions:
        log(f"PLAN improve+extract session={s}")

    if not execute:
        log("INFO dry run complete — pass --execute to run")
        return 0

    api_key = fetch_api_key()
    if not api_key:
        log("ERROR Cognee API key not available from Vaultwarden")
        return 1

    dataset_id = get_dataset_id(api_key) or recreate_dataset(api_key)
    log(f"INFO dataset ready id={dataset_id}")

    for session_id in sessions:
        outcome = trigger_improve(api_key, session_id)
        if outcome in ("lock_held", "ok", "timeout"):
            final = poll_dataset_status(api_key, dataset_id)
            log(f"INFO improve final={final} session={session_id}")
        else:
            log(f"WARN improve outcome={outcome} session={session_id}")

    log("INFO lesson extraction pass finished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
