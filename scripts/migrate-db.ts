/**
 * One-time migration: copy messages, archived_messages, and thread_messages
 * from the repo DB into the workspace DB so everything lives in one place.
 * 
 * Run: npx tsx scripts/migrate-db.ts
 */

import "dotenv/config";
import Database from "better-sqlite3";
import path from "path";
import { initConfig, config } from "../src/config.js";

async function main() {
  await initConfig();

  const repoDb = path.resolve(import.meta.dirname, "..", "patronum.db");
  const workspaceDb = path.join(config.workspace, "patronum.db");

  if (repoDb === workspaceDb) {
    console.log("Repo DB and workspace DB are the same file — nothing to migrate.");
    return;
  }

  console.log(`Source (repo):     ${repoDb}`);
  console.log(`Target (workspace): ${workspaceDb}`);

  const src = new Database(repoDb, { readonly: true });
  const dst = new Database(workspaceDb);
  dst.pragma("journal_mode = WAL");

  // Ensure target tables exist
  dst.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  dst.exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id)`);

  dst.exec(`
    CREATE TABLE IF NOT EXISTS archived_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      compacted_at INTEGER NOT NULL,
      compaction_reason TEXT
    )
  `);
  dst.exec(`CREATE INDEX IF NOT EXISTS idx_archived_chat_id ON archived_messages(chat_id, id)`);

  dst.exec(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
  dst.exec(`CREATE INDEX IF NOT EXISTS idx_thread_chat_id ON thread_messages(chat_id, timestamp)`);

  // Check what's already in target
  const existingMsgs = (dst.prepare("SELECT COUNT(*) as c FROM messages").get() as any).c;
  if (existingMsgs > 0) {
    console.log(`Target already has ${existingMsgs} messages — skipping messages migration to avoid dupes.`);
  } else {
    // Migrate messages
    const msgs = src.prepare("SELECT chat_id, role, content_json, created_at FROM messages ORDER BY id ASC").all() as any[];
    const insert = dst.prepare("INSERT INTO messages (chat_id, role, content_json, created_at) VALUES (?, ?, ?, ?)");
    const migrate = dst.transaction(() => {
      for (const m of msgs) {
        insert.run(m.chat_id, m.role, m.content_json, m.created_at);
      }
    });
    migrate();
    console.log(`Migrated ${msgs.length} messages`);
  }

  // Migrate archived_messages
  const existingArchived = (dst.prepare("SELECT COUNT(*) as c FROM archived_messages").get() as any).c;
  if (existingArchived > 0) {
    console.log(`Target already has ${existingArchived} archived messages — skipping.`);
  } else {
    const archived = src.prepare("SELECT chat_id, role, content_json, created_at, compacted_at, compaction_reason FROM archived_messages ORDER BY id ASC").all() as any[];
    if (archived.length > 0) {
      const insertA = dst.prepare("INSERT INTO archived_messages (chat_id, role, content_json, created_at, compacted_at, compaction_reason) VALUES (?, ?, ?, ?, ?, ?)");
      const migrateA = dst.transaction(() => {
        for (const a of archived) {
          insertA.run(a.chat_id, a.role, a.content_json, a.created_at, a.compacted_at, a.compaction_reason);
        }
      });
      migrateA();
      console.log(`Migrated ${archived.length} archived messages`);
    } else {
      console.log("No archived messages to migrate");
    }
  }

  // Migrate thread_messages
  const srcTables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_messages'").get();
  if (srcTables) {
    const existingThreads = (dst.prepare("SELECT COUNT(*) as c FROM thread_messages").get() as any).c;
    if (existingThreads > 0) {
      console.log(`Target already has ${existingThreads} thread messages — skipping.`);
    } else {
      const threads = src.prepare("SELECT id, chat_id, author, content, timestamp FROM thread_messages ORDER BY timestamp ASC").all() as any[];
      if (threads.length > 0) {
        const insertT = dst.prepare("INSERT OR IGNORE INTO thread_messages (id, chat_id, author, content, timestamp) VALUES (?, ?, ?, ?, ?)");
        const migrateT = dst.transaction(() => {
          for (const t of threads) {
            insertT.run(t.id, t.chat_id, t.author, t.content, t.timestamp);
          }
        });
        migrateT();
        console.log(`Migrated ${threads.length} thread messages`);
      } else {
        console.log("No thread messages to migrate");
      }
    }
  }

  src.close();
  dst.close();

  console.log("\nDone! All data consolidated into workspace DB.");
  console.log(`You can verify: sqlite3 ${workspaceDb} ".tables"`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
