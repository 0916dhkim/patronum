import Database from "better-sqlite3";
import path from "path";
import crypto from "node:crypto";
import { config } from "./config.js";



export interface ThreadMessage {
  id: string;
  author: "user" | "main" | "alex" | "iris" | "quill" | "system";
  content: string;
  timestamp: number;
  chatId: string;
}

const MAX_THREAD_MESSAGES = 200;

let db: Database.Database;

export function initThread(): void {
  const dbPath = path.join(config.workspace, "patronum.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_thread_chat_id ON thread_messages(chat_id, timestamp)
  `);
}

export function loadThread(chatId: string): ThreadMessage[] {
  const rows = db
    .prepare(
      `SELECT id, chat_id, author, content, timestamp FROM thread_messages
       WHERE chat_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(chatId, MAX_THREAD_MESSAGES) as ThreadMessage[];

  return rows.reverse();
}

export function appendToThread(
  chatId: string,
  author: ThreadMessage["author"],
  content: string
): ThreadMessage {
  const msg: ThreadMessage = {
    id: crypto.randomUUID(),
    author,
    content,
    timestamp: Date.now(),
    chatId,
  };

  db.prepare(
    `INSERT INTO thread_messages (id, chat_id, author, content, timestamp) VALUES (?, ?, ?, ?, ?)`
  ).run(msg.id, msg.chatId, msg.author, msg.content, msg.timestamp);

  return msg;
}

/**
 * Format the thread as a readable context block for agent system prompts.
 */
export function formatThreadForContext(thread: ThreadMessage[]): string {
  if (thread.length === 0) return "";

  const lines = thread.map((m) => `[${m.author}] ${m.content}`);
  return `[Conversation Thread]\n${lines.join("\n")}`;
}


