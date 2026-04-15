import Database from "better-sqlite3";
import path from "path";
import crypto from "node:crypto";
import { config } from "./config.js";
import type { Message } from "./types.js";

let db: Database.Database;

export function initAgentThread(): void {
  const dbPath = path.join(config.workspace, "patronum.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_threads (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      closed_at INTEGER
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_threads_lookup
      ON agent_threads(chat_id, name, status)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES agent_threads(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_thread_messages
      ON agent_thread_messages(thread_id, timestamp)
  `);

  // Table for subagent internal messages (the full message loop)
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_internal_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      internal_messages_json TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES agent_threads(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_subagent_internal_messages_lookup
      ON subagent_internal_messages(thread_id)
  `);
}

export function getOrCreateThread(
  chatId: string,
  name: string
): { id: string; name: string } {
  // Find active thread
  const existing = db
    .prepare(
      `SELECT id, name FROM agent_threads
       WHERE chat_id = ? AND name = ? AND status = 'active'
       LIMIT 1`
    )
    .get(chatId, name) as { id: string; name: string } | undefined;

  if (existing) {
    return existing;
  }

  // Create new thread
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO agent_threads (id, chat_id, name, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`
  ).run(id, chatId, name, now);

  return { id, name };
}

export function findThread(
  chatId: string,
  name: string
): { id: string; name: string } | null {
  const result = db
    .prepare(
      `SELECT id, name FROM agent_threads
       WHERE chat_id = ? AND name = ? AND status = 'active'
       LIMIT 1`
    )
    .get(chatId, name) as { id: string; name: string } | undefined;

  return result || null;
}

/**
 * Find a thread by chat ID and name, regardless of status.
 * Used for forensics/debugging tools that need to inspect closed threads.
 */
export function findThreadAnyStatus(
  chatId: string,
  name: string
): { id: string; name: string } | null {
  const result = db
    .prepare(
      `SELECT id, name FROM agent_threads
       WHERE chat_id = ? AND name = ?
       LIMIT 1`
    )
    .get(chatId, name) as { id: string; name: string } | undefined;

  return result || null;
}

export function appendToAgentThread(
  threadId: string,
  author: string,
  content: string
): void {
  const id = crypto.randomUUID();
  const timestamp = Date.now();

  db.prepare(
    `INSERT INTO agent_thread_messages (id, thread_id, author, content, timestamp)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, threadId, author, content, timestamp);
}

export function getThreadMessageCount(threadId: string): number {
  const result = db
    .prepare(
      `SELECT COUNT(*) as count FROM agent_thread_messages
       WHERE thread_id = ?`
    )
    .get(threadId) as { count: number } | undefined;

  return result?.count ?? 0;
}

export function loadAgentThread(
  threadId: string
): Array<{ author: string; content: string; timestamp: number }> {
  const rows = db
    .prepare(
      `SELECT author, content, timestamp FROM agent_thread_messages
       WHERE thread_id = ?
       ORDER BY timestamp ASC`
    )
    .all(threadId) as Array<{ author: string; content: string; timestamp: number }>;

  return rows;
}

export function formatAgentThread(threadId: string, name: string): string {
  const messages = loadAgentThread(threadId);

  if (messages.length === 0) {
    return `[Agent Thread: "${name}"] — empty thread, you are the first agent in this loop.`;
  }

  const lines = messages.map((m) => `[${m.author}] ${m.content}`);
  return `[Agent Thread: "${name}"]\n\n${lines.join("\n")}`;
}

export interface ActiveThread {
  id: string;
  name: string;
  messageCount: number;
  lastActivity: number;
}

export function listActiveThreads(chatId: string): ActiveThread[] {
  const rows = db
    .prepare(
      `SELECT 
        t.id, t.name, 
        COUNT(m.id) as messageCount,
        COALESCE(MAX(m.timestamp), 0) as lastActivity
       FROM agent_threads t
       LEFT JOIN agent_thread_messages m ON t.id = m.thread_id
       WHERE t.chat_id = ? AND t.status = 'active'
       GROUP BY t.id, t.name
       ORDER BY lastActivity DESC`
    )
    .all(chatId) as Array<{
    id: string;
    name: string;
    messageCount: number;
    lastActivity: number;
  }>;

  return rows;
}

export function closeThread(chatId: string, name: string): boolean {
  const result = db
    .prepare(
      `UPDATE agent_threads SET status = 'closed', closed_at = ?
       WHERE chat_id = ? AND name = ? AND status = 'active'`
    )
    .run(Date.now(), chatId, name);

  return result.changes > 0;
}

/**
 * Persist the full sanitized message array from a subagent run to the database.
 * This is called at the end of runAgentWithThread, whether the run succeeds or fails.
 * The messages array contains the complete internal loop: user prompts, assistant responses,
 * tool calls, and tool results.
 */
export function persistSubagentMessages(
  threadId: string,
  agentName: string,
  messages: Message[]
): void {
  try {
    const id = crypto.randomUUID();
    const internalMessagesJson = JSON.stringify(messages);

    db.prepare(
      `INSERT INTO subagent_internal_messages
       (id, thread_id, agent_name, internal_messages_json)
       VALUES (?, ?, ?, ?)`
    ).run(id, threadId, agentName, internalMessagesJson);
  } catch (err) {
    // Log warning but don't crash — persistence is best-effort
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[persist] Failed to write subagent messages for thread ${threadId}: ${message}`);
  }
}

/**
 * Load subagent internal messages for a given thread, optionally filtered by agent name.
 * Returns an array of { agentName, messages } objects.
 */
export function loadSubagentMessages(
  threadId: string,
  agentNameFilter?: string
): Array<{ agentName: string; messages: Message[] }> {
  const query = agentNameFilter
    ? `SELECT agent_name, internal_messages_json
       FROM subagent_internal_messages
       WHERE thread_id = ? AND agent_name = ?
       ORDER BY rowid ASC`
    : `SELECT agent_name, internal_messages_json
       FROM subagent_internal_messages
       WHERE thread_id = ?
       ORDER BY rowid ASC`;

  const rows = (
    agentNameFilter
      ? db.prepare(query).all(threadId, agentNameFilter)
      : db.prepare(query).all(threadId)
  ) as Array<{ agent_name: string; internal_messages_json: string }>;

  return rows.map((row) => ({
    agentName: row.agent_name,
    messages: JSON.parse(row.internal_messages_json) as Message[],
  }));
}
