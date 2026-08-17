import Database from "better-sqlite3";
import path from "path";
import type { Message } from "./types.js";
import { config } from "./config.js";

let db: Database.Database;

export function initSession(): void {
  const dbPath = path.join(config.workspace, "patronum.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      telegram_message_id INTEGER
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id)
  `);
  db.exec(`
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archived_chat_id ON archived_messages(chat_id, id)
  `);

  // Idempotent migration: add telegram_message_id column if it doesn't exist
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
    const hasColumn = tableInfo.some((col) => col.name === "telegram_message_id");
    if (!hasColumn) {
      db.exec(`ALTER TABLE messages ADD COLUMN telegram_message_id INTEGER`);
      console.log("[migration] Added telegram_message_id column to messages table");
    }
  } catch (err) {
    console.error("[migration] Failed to check/add telegram_message_id column:", err);
    throw err;
  }

  // Initialize audit ledger for telegram_read_message tool
  initAuditLedger();
}

// ---------------------------------------------------------------------------
// Telegram Read Audit Ledger
// ---------------------------------------------------------------------------

interface AuditRowInput {
  requesting_chat: string;
  requested_chat_id: string;
  requested_message_id: number;
  stage_msg_id: number;
  content_hash: string;
}

interface OutstandingRow {
  id: number;
  stage_msg_id: number;
  [key: string]: unknown;
}

/**
 * Idempotent migration: create the audit ledger table if it does not exist.
 */
export function initAuditLedger(): void {
  const dbPath = path.join(config.workspace, "patronum.db");
  const auditDb = new Database(dbPath);
  auditDb.pragma("journal_mode = WAL");

  auditDb.exec(`
    CREATE TABLE IF NOT EXISTS telegram_read_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requesting_chat TEXT NOT NULL,
      requested_chat_id TEXT NOT NULL,
      requested_message_id INTEGER NOT NULL,
      stage_msg_id INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'outstanding',
      delete_outcome TEXT,
      duration_ms INTEGER,
      sweep_retries INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (status IN ('outstanding', 'done', 'failed'))
    )
  `);

  auditDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_status
    ON telegram_read_audit(status, created_at)
  `);

  auditDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_stage_msg
    ON telegram_read_audit(stage_msg_id)
  `);

  auditDb.close();
}

/**
 * Insert an outstanding audit row BEFORE deleting the staged copy.
 * Returns the new row id.
 */
export function persistOutstandingRow(input: AuditRowInput): number {
  const dbPath = path.join(config.workspace, "patronum.db");
  const auditDb = new Database(dbPath);
  auditDb.pragma("journal_mode = WAL");

  try {
    // Self-heal: create the table if it does not exist, so forward-before-persist
    // can never recur even if initAuditLedger was not called.
    auditDb.exec(`
      CREATE TABLE IF NOT EXISTS telegram_read_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requesting_chat TEXT NOT NULL,
        requested_chat_id TEXT NOT NULL,
        requested_message_id INTEGER NOT NULL,
        stage_msg_id INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'outstanding',
        delete_outcome TEXT,
        duration_ms INTEGER,
        sweep_retries INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status IN ('outstanding', 'done', 'failed'))
      )
    `);
    auditDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_status
      ON telegram_read_audit(status, created_at)
    `);
    auditDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_stage_msg
      ON telegram_read_audit(stage_msg_id)
    `);

    const result = auditDb
      .prepare(
        `INSERT INTO telegram_read_audit
         (requesting_chat, requested_chat_id, requested_message_id, stage_msg_id, content_hash, status)
         VALUES (?, ?, ?, ?, ?, 'outstanding')`
      )
      .run(
        input.requesting_chat,
        input.requested_chat_id,
        input.requested_message_id,
        input.stage_msg_id,
        input.content_hash,
      );
    return Number(result.lastInsertRowid);
  } finally {
    auditDb.close();
  }
}

/**
 * Mark an audit row as done after successful delete.
 */
export function markAuditRowDone(id: number, durationMs: number): void {
  const dbPath = path.join(config.workspace, "patronum.db");
  const auditDb = new Database(dbPath);
  auditDb.pragma("journal_mode = WAL");

  try {
    auditDb
      .prepare(
        `UPDATE telegram_read_audit
         SET status = 'done', duration_ms = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(durationMs, id);
  } finally {
    auditDb.close();
  }
}

/**
 * Return all rows with status='outstanding' for the sweeper to retry cleanup.
 */
export function getOutstandingRows(): OutstandingRow[] {
  const dbPath = path.join(config.workspace, "patronum.db");
  const auditDb = new Database(dbPath);
  auditDb.pragma("journal_mode = WAL");

  try {
    return auditDb
      .prepare(
        `SELECT id, stage_msg_id, requesting_chat, requested_chat_id, requested_message_id, content_hash, sweep_retries, created_at
         FROM telegram_read_audit
         WHERE status = 'outstanding'
         ORDER BY id ASC`
      )
      .all() as OutstandingRow[];
  } finally {
    auditDb.close();
  }
}

/**
 * Increment sweep_retries for an outstanding audit row.
 * Used by the sweeper to track persistent deletion failures.
 */
export function incrementSweepRetries(id: number): number {
  const dbPath = path.join(config.workspace, "patronum.db");
  const auditDb = new Database(dbPath);
  auditDb.pragma("journal_mode = WAL");

  try {
    auditDb
      .prepare(
        `UPDATE telegram_read_audit
         SET sweep_retries = sweep_retries + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(id);
    const row = auditDb
      .prepare(`SELECT sweep_retries FROM telegram_read_audit WHERE id = ?`)
      .get(id) as { sweep_retries: number } | undefined;
    return row?.sweep_retries ?? 0;
  } finally {
    auditDb.close();
  }
}

export function loadHistory(chatId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT role, content_json FROM messages
       WHERE chat_id = ?
       ORDER BY id ASC`
    )
    .all(chatId) as { role: string; content_json: string }[];

  const messages = rows.map((row) => ({
    role: row.role as Message["role"],
    content: JSON.parse(row.content_json),
  }));

  // Find the first clean boundary: a user message with plain text content (not tool_result)
  // This ensures we don't start mid tool-call pair when the window cuts off the matching tool_use
  let startIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isCleanUserMessage =
      msg.role === "user" &&
      (typeof msg.content === "string" ||
        (Array.isArray(msg.content) && !msg.content.some((b) => b.type === "tool_result")));
    if (isCleanUserMessage) {
      startIndex = i;
      break;
    }
  }

  return messages.slice(startIndex);
}

export function saveMessage(chatId: string, message: Message, telegramMessageId?: number): void {
  const contentJson =
    typeof message.content === "string"
      ? JSON.stringify(message.content)
      : JSON.stringify(message.content);

  db.prepare(
    `INSERT INTO messages (chat_id, role, content_json, telegram_message_id) VALUES (?, ?, ?, ?)`
  ).run(chatId, message.role, contentJson, telegramMessageId ?? null);
}

/**
 * Archive messages before they are compacted away, so history is never lost.
 */
export function archiveMessages(
  chatId: string,
  messages: Message[],
  reason: string
): void {
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(
    `INSERT INTO archived_messages (chat_id, role, content_json, created_at, compacted_at, compaction_reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const archiveAll = db.transaction(() => {
    for (const msg of messages) {
      const contentJson = JSON.stringify(msg.content);
      insert.run(chatId, msg.role, contentJson, now, now, reason);
    }
  });
  archiveAll();
  console.log(
    `[archive] Archived ${messages.length} messages for chat=${chatId} (reason: ${reason})`
  );
}

/**
 * Replace all stored messages for a chat with a new set (used after compaction).
 */
export function replaceHistory(chatId: string, messages: Message[]): void {
  const deleteStmt = db.prepare(`DELETE FROM messages WHERE chat_id = ?`);
  const insertStmt = db.prepare(
    `INSERT INTO messages (chat_id, role, content_json) VALUES (?, ?, ?)`
  );

  const replaceAll = db.transaction(() => {
    deleteStmt.run(chatId);
    for (const msg of messages) {
      const contentJson = JSON.stringify(msg.content);
      insertStmt.run(chatId, msg.role, contentJson);
    }
  });

  replaceAll();
}

/**
 * Update the telegram_message_id for N most recent assistant messages in a chat.
 * Used when a Claude turn produces multiple assistant messages that get combined into one Telegram message.
 * All assistant messages from the turn should be stamped with the same Telegram ID for proper context resolution.
 *
 * @param chatId - The chat ID
 * @param count - Number of most recent assistant messages to update
 * @param telegramMessageId - The Telegram message ID to stamp
 */
export function updateAssistantMessagesTelegramId(
  chatId: string,
  count: number,
  telegramMessageId: number
): void {
  const stmt = db.prepare(
    `SELECT id FROM messages
     WHERE chat_id = ? AND role = 'assistant'
     ORDER BY id DESC
     LIMIT ?`
  );
  const rows = stmt.all(chatId, count) as Array<{ id: number }>;

  if (rows.length > 0) {
    const updateStmt = db.prepare(
      `UPDATE messages SET telegram_message_id = ? WHERE id = ?`
    );
    for (const row of rows) {
      updateStmt.run(telegramMessageId, row.id);
    }
  }
}

/**
 * Update telegram_message_id for a contiguous range of assistant messages,
 * addressed by 1-based position from the most recent (1 = most recent).
 * Used to stamp the pre-tool assistant messages that were flushed as their own
 * Telegram message at a tool-call boundary.
 */
export function updateAssistantMessagesTelegramIdAtOffset(
  chatId: string,
  nthFromMostRecent: number,
  count: number,
  telegramMessageId: number
): void {
  const rows = db.prepare(
    `SELECT id FROM messages
     WHERE chat_id = ? AND role = 'assistant'
     ORDER BY id DESC
     LIMIT ? OFFSET ?`
  ).all(chatId, count, nthFromMostRecent - 1) as Array<{ id: number }>;

  if (rows.length > 0) {
    const updateStmt = db.prepare(
      `UPDATE messages SET telegram_message_id = ? WHERE id = ?`
    );
    for (const row of rows) {
      updateStmt.run(telegramMessageId, row.id);
    }
  }
}
