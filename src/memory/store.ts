/**
 * Vector memory store using sqlite-vec + better-sqlite3.
 * Stores conversation chunks with embeddings for semantic search.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import { config } from "../config.js";

let db: Database.Database;

// voyage-3-large produces 1024-dimensional embeddings
const EMBEDDING_DIM = 1024;

export function initMemoryStore(): void {
  const dbPath = path.join(config.workspace, "patronum.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Create the metadata table for memory chunks
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      turn_number INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      chunk_type TEXT NOT NULL DEFAULT 'conversation'
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_chat ON memory_chunks(chat_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_type ON memory_chunks(chunk_type)
  `);

  // Create the virtual vector table for embeddings
  // sqlite-vec uses vec0 virtual table type
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    )
  `);
}

/**
 * Store a chunk with its embedding.
 */
export function storeChunk(
  chatId: string,
  chunkText: string,
  embedding: number[],
  options?: {
    turnNumber?: number;
    chunkType?: string;
  }
): number {
  const turnNumber = options?.turnNumber ?? null;
  const chunkType = options?.chunkType ?? "conversation";

  const result = db
    .prepare(
      `INSERT INTO memory_chunks (chat_id, chunk_text, turn_number, chunk_type)
       VALUES (?, ?, ?, ?)`
    )
    .run(chatId, chunkText, turnNumber, chunkType);

  const chunkId = result.lastInsertRowid; // BigInt from better-sqlite3

  // Insert embedding into vector table
  // sqlite-vec requires BigInt for primary key with better-sqlite3
  db.prepare(
    `INSERT INTO memory_vec (chunk_id, embedding) VALUES (?, ?)`
  ).run(BigInt(chunkId), new Float32Array(embedding));

  return Number(chunkId);
}

export interface MemorySearchResult {
  chunkId: number;
  chatId: string;
  chunkText: string;
  chunkType: string;
  createdAt: string;
  distance: number;
}

/**
 * Search for similar chunks using vector similarity.
 * Returns top-k results ordered by distance (ascending = most similar).
 */
export function searchChunks(
  queryEmbedding: number[],
  options?: {
    topK?: number;
    chatId?: string;
    chunkType?: string;
    afterDate?: string;
    beforeDate?: string;
  }
): MemorySearchResult[] {
  const topK = options?.topK ?? 8;

  // sqlite-vec KNN query
  // We search more than needed if we're filtering, then apply filters
  const searchLimit = options?.chatId || options?.chunkType || options?.afterDate || options?.beforeDate
    ? topK * 4  // over-fetch when filtering
    : topK;

  const vecResults = db
    .prepare(
      `SELECT chunk_id, distance
       FROM memory_vec
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(new Float32Array(queryEmbedding), searchLimit) as Array<{
      chunk_id: number;
      distance: number;
    }>;

  if (vecResults.length === 0) return [];

  // Fetch metadata and apply filters
  const results: MemorySearchResult[] = [];

  for (const vec of vecResults) {
    if (results.length >= topK) break;

    const chunk = db
      .prepare(
        `SELECT id, chat_id, chunk_text, chunk_type, created_at
         FROM memory_chunks WHERE id = ?`
      )
      .get(vec.chunk_id) as {
        id: number;
        chat_id: string;
        chunk_text: string;
        chunk_type: string;
        created_at: string;
      } | undefined;

    if (!chunk) continue;

    // Apply optional filters
    if (options?.chatId && chunk.chat_id !== options.chatId) continue;
    if (options?.chunkType && chunk.chunk_type !== options.chunkType) continue;
    if (options?.afterDate && chunk.created_at < options.afterDate) continue;
    if (options?.beforeDate && chunk.created_at > options.beforeDate) continue;

    results.push({
      chunkId: chunk.id,
      chatId: chunk.chat_id,
      chunkText: chunk.chunk_text,
      chunkType: chunk.chunk_type,
      createdAt: chunk.created_at,
      distance: vec.distance,
    });
  }

  return results;
}

/**
 * Get total chunk count (for diagnostics).
 */
export function getChunkCount(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM memory_chunks`).get() as { count: number };
  return row.count;
}
