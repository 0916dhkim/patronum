import Database from "better-sqlite3";
import path from "path";
import type { Message } from "./types.js";
import { config } from "./config.js";

const DB_PATH = path.join(config.workspace, "patronum.db");
let db: Database.Database;

export function initSession(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

export function saveMessage(chatId: string, message: Message): void {
  const contentJson =
    typeof message.content === "string"
      ? JSON.stringify(message.content)
      : JSON.stringify(message.content);

  db.prepare(
    `INSERT INTO messages (chat_id, role, content_json) VALUES (?, ?, ?)`
  ).run(chatId, message.role, contentJson);
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
