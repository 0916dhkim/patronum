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
 * Extract text content from a message's content_json.
 * Handles both string and array of content blocks.
 */
function extractTextContent(contentJson: string): string {
  try {
    const content = JSON.parse(contentJson);

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text);
        }
      }
      return textParts.join("\n");
    }
  } catch {
    return "";
  }

  return "";
}

/**
 * Update the telegram_message_id for the most recently saved message of a given role in a chat.
 * Used to associate Telegram message IDs with bot messages after sending.
 */
export function updateLastMessageTelegramId(
  chatId: string,
  role: "user" | "assistant",
  telegramMessageId: number
): void {
  const stmt = db.prepare(
    `SELECT id FROM messages
     WHERE chat_id = ? AND role = ?
     ORDER BY id DESC
     LIMIT 1`
  );
  const lastMsg = stmt.get(chatId, role) as { id: number } | undefined;

  if (lastMsg) {
    db.prepare(`UPDATE messages SET telegram_message_id = ? WHERE id = ?`).run(
      telegramMessageId,
      lastMsg.id
    );
  }
}

/**
 * Look up a message by its Telegram message ID. Returns the role and truncated text content.
 * Used to resolve reply annotations to actual message content.
 * Returns null if message not found.
 */
export function getMessageByTelegramId(
  chatId: string,
  telegramMessageId: number
): { role: "user" | "assistant"; text: string } | null {
  const row = db
    .prepare(
      `SELECT role, content_json FROM messages
       WHERE chat_id = ? AND telegram_message_id = ?
       LIMIT 1`
    )
    .get(chatId, telegramMessageId) as
    | { role: string; content_json: string }
    | undefined;

  if (!row) {
    return null;
  }

  try {
    const content = JSON.parse(row.content_json);
    let text = "";

    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // Extract text from content blocks
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text);
        }
      }
      text = textParts.join("\n");
    }

    // Truncate to 200 chars and remove [Reply to message #...] annotations if present
    text = text
      .replace(/^\[Reply to message #\d+\]\s*/i, "")
      .trim();
    if (text.length > 200) {
      text = text.substring(0, 200) + "…";
    }

    return {
      role: row.role as "user" | "assistant",
      text,
    };
  } catch {
    return null;
  }
}

export interface AdjacentMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

/**
 * Find the message with created_at closest to (but not after) the given timestamp,
 * then fetch window messages before and after by id order.
 * Filters to user/assistant roles with text content only.
 * Returns null if no messages found or time gap > 5 minutes.
 * Truncates message text to 500 chars.
 */
export function getAdjacentMessages(
  chatId: string,
  chunkTimestamp: string,
  window: number = 3
): AdjacentMessage[] | null {
  // Find the closest message by created_at (at or before chunk timestamp)
  const anchorMsg = db
    .prepare(
      `SELECT id, created_at FROM messages
       WHERE chat_id = ? AND created_at <= ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(chatId, chunkTimestamp) as { id: number; created_at: string } | undefined;

  if (!anchorMsg) {
    // No messages found around this timestamp
    return null;
  }

  // Check time gap - if anchor message is >5 minutes from chunk, don't return misleading context
  const chunkTime = new Date(chunkTimestamp).getTime();
  const anchorTime = new Date(anchorMsg.created_at).getTime();
  const gapMs = Math.abs(chunkTime - anchorTime);
  const gapMinutes = gapMs / (1000 * 60);

  if (gapMinutes > 5) {
    return null;
  }

  // Fetch window messages before and after by id order
  const messages = db
    .prepare(
      `SELECT id, role, content_json, created_at FROM messages
       WHERE chat_id = ? AND id >= ? - ? AND id <= ? + ?
       ORDER BY id ASC`
    )
    .all(chatId, anchorMsg.id, window, anchorMsg.id, window) as Array<{
      id: number;
      role: string;
      content_json: string;
      created_at: string;
    }>;

  if (messages.length === 0) {
    return null;
  }

  // Filter to user/assistant roles with text content, truncate to 500 chars
  const result: AdjacentMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      const text = extractTextContent(msg.content_json);
      if (text.trim()) {
        result.push({
          role: msg.role as "user" | "assistant",
          text: text.length > 500 ? text.substring(0, 500) + "…" : text,
          createdAt: msg.created_at,
        });
      }
    }
  }

  return result.length > 0 ? result : null;
}
