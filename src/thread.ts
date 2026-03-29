import Database from "better-sqlite3";
import path from "path";
import crypto from "node:crypto";
import { config } from "./config.js";

export interface ThreadMessage {
  id: string;
  author: "user" | "lin" | "alex" | "iris" | "quill" | "system";
  content: string;
  timestamp: number;
  chatId: string;
}

const MAX_THREAD_MESSAGES = 200;

// Compaction thresholds — configurable via env
const COMPACT_AFTER_MESSAGES = parseInt(process.env.COMPACT_AFTER_MESSAGES || "100", 10);
const COMPACT_KEEP_RECENT = parseInt(process.env.COMPACT_KEEP_RECENT || "20", 10);
const COMPACT_CHAR_THRESHOLD = 50_000;

const API_URL = "https://api.anthropic.com/v1/messages";
const COMPACTION_MODEL = "claude-3-5-haiku-20241022"; // cheap model for summaries

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

/**
 * Check whether the thread needs compaction based on message count or total character size.
 */
function needsCompaction(thread: ThreadMessage[]): boolean {
  if (thread.length >= COMPACT_AFTER_MESSAGES) return true;

  const totalChars = thread.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars >= COMPACT_CHAR_THRESHOLD) return true;

  return false;
}

/**
 * Summarize a set of thread messages using Claude Haiku.
 */
async function summarizeThreadMessages(messages: ThreadMessage[]): Promise<string> {
  const transcript = messages
    .map((m) => `[${m.author}] ${m.content}`)
    .join("\n\n");

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.claudeToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/2.1.85",
      "x-app": "cli",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: COMPACTION_MODEL,
      max_tokens: 2048,
      system:
        "You are a precise summarizer. Summarize the multi-agent conversation thread below into a compact but complete summary. Preserve all key facts, decisions, task assignments, code changes, and context needed to continue the conversation. Note which agent said what when it matters. Be concise but thorough. Output only the summary.",
      messages: [
        {
          role: "user",
          content: `Summarize this conversation thread:\n\n${transcript}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Thread compaction API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  return data.content.find((b) => b.type === "text")?.text ?? "(summary unavailable)";
}

/**
 * Compact the thread for a chat if it exceeds thresholds.
 *
 * Strategy:
 * - Keep the last COMPACT_KEEP_RECENT messages verbatim
 * - Summarize everything older into a single [system] summary message
 * - Delete the old messages and insert the summary
 *
 * Returns true if compaction occurred.
 */
export async function compactThread(chatId: string): Promise<boolean> {
  const thread = loadThread(chatId);

  if (!needsCompaction(thread)) return false;

  const keepCount = Math.min(COMPACT_KEEP_RECENT, thread.length);
  const splitIndex = thread.length - keepCount;

  if (splitIndex <= 0) return false; // nothing to compact

  const toSummarize = thread.slice(0, splitIndex);
  const toKeep = thread.slice(splitIndex);

  console.log(
    `[thread-compaction] chat=${chatId}: compacting ${toSummarize.length} messages, keeping ${toKeep.length}`
  );

  const summary = await summarizeThreadMessages(toSummarize);

  console.log(
    `[thread-compaction] Summary generated (${summary.length} chars) from ${toSummarize.length} messages`
  );

  // Atomic: delete old messages and insert summary
  const deleteStmt = db.prepare(`DELETE FROM thread_messages WHERE id = ?`);
  const insertStmt = db.prepare(
    `INSERT INTO thread_messages (id, chat_id, author, content, timestamp) VALUES (?, ?, ?, ?, ?)`
  );

  const summaryMsg: ThreadMessage = {
    id: crypto.randomUUID(),
    author: "system",
    content: `Summary of earlier conversation:\n\n${summary}`,
    // Timestamp just before the oldest kept message so ordering is correct
    timestamp: toKeep.length > 0 ? toKeep[0].timestamp - 1 : Date.now(),
    chatId,
  };

  const compact = db.transaction(() => {
    for (const msg of toSummarize) {
      deleteStmt.run(msg.id);
    }
    insertStmt.run(
      summaryMsg.id,
      summaryMsg.chatId,
      summaryMsg.author,
      summaryMsg.content,
      summaryMsg.timestamp
    );
  });

  compact();

  console.log(`[thread-compaction] Done. Thread now has ${toKeep.length + 1} messages.`);
  return true;
}
