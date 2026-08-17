/**
 * Migration ledger — tracks Patronum chunk → Cognee data_id mapping.
 * Stored in Patronum SQLite alongside operational tables.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { config } from "../config.js";

let db: Database.Database;

export function initMigrationLedger(): void {
  const dbPath = path.join(config.workspace, "patronum.db");
  db = new Database(dbPath);

  // VESTIGIAL: cognee_migration_ledger tracked the legacy add()→cognify()
  // pipeline. The memory redesign (sessions → improve) supersedes it; the
  // cognify_status/checked_at columns are no longer driven by any write path.
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

export function recordIngestion(
  patronumChunkId: number,
  cogneeDataId: string,
  externalMetadata: Record<string, unknown>
): void {
  db.prepare(`
    INSERT OR REPLACE INTO cognee_migration_ledger
      (patronum_chunk_id, cognee_data_id, cognify_status, external_metadata_json)
    VALUES (?, ?, 'pending', ?)
  `).run(patronumChunkId, cogneeDataId, JSON.stringify(externalMetadata));
}

export function updateCognifyStatus(
  patronumChunkId: number,
  status: string
): void {
  db.prepare(`
    UPDATE cognee_migration_ledger
    SET cognify_status = ?, cognify_checked_at = datetime('now')
    WHERE patronum_chunk_id = ?
  `).run(status, patronumChunkId);
}

export function getPendingChunks(): Array<{ patronum_chunk_id: number }> {
  return db.prepare(`
    SELECT patronum_chunk_id FROM cognee_migration_ledger
    WHERE cognify_status = 'pending'
  `).all() as Array<{ patronum_chunk_id: number }>;
}

export function isChunkIngested(patronumChunkId: number): boolean {
  const row = db.prepare(`
    SELECT 1 FROM cognee_migration_ledger
    WHERE patronum_chunk_id = ?
  `).get(patronumChunkId);
  return row !== undefined;
}

export function getLedgerCount(): { total: number; pending: number; completed: number; failed: number } {
  const total = (db.prepare("SELECT COUNT(*) as c FROM cognee_migration_ledger").get() as { c: number }).c;
  const pending = (db.prepare("SELECT COUNT(*) as c FROM cognee_migration_ledger WHERE cognify_status = 'pending'").get() as { c: number }).c;
  const completed = (db.prepare("SELECT COUNT(*) as c FROM cognee_migration_ledger WHERE cognify_status = 'completed'").get() as { c: number }).c;
  const failed = (db.prepare("SELECT COUNT(*) as c FROM cognee_migration_ledger WHERE cognify_status = 'failed'").get() as { c: number }).c;
  return { total, pending, completed, failed };
}
