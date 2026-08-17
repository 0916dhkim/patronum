/**
 * Migration ledger — tracks Patronum chunk → Cognee data_id mapping.
 * Stored in Patronum SQLite alongside operational tables.
 *
 * VESTIGIAL: cognee_migration_ledger tracked the legacy add()→cognify()
 * pipeline. The memory redesign (sessions → improve) supersedes it; only
 * initMigrationLedger remains (harmless table creation).
 */

import Database from "better-sqlite3";
import path from "node:path";
import { config } from "../config.js";

export function initMigrationLedger(): void {
  const dbPath = path.join(config.workspace, "patronum.db");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cognee_migration_ledger (
      patronum_chunk_id INTEGER PRIMARY KEY,
      cognee_data_id TEXT,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
      cognify_status TEXT DEFAULT 'pending',
      cognify_checked_at TEXT,
      external_metadata_json TEXT
    )
  `);

  console.log("[migration] Ledger table initialized");
}
