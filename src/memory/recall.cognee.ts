/**
 * Auto-recall orchestration — Cognee-aware version.
 * Routes to Cognee when backend=cognee, falls back to SQLite otherwise.
 */

import { embed, embedQuery } from "./embeddings.js";
import { storeChunk, searchChunks, type MemorySearchResult } from "./store.js";
import { health, recall, formatRecallResults, add, cognify, remember, addWithMetadata } from "./cognee_client.js";
import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from "../types.js";
import { config } from "../config.js";

// Read feature flags from config (added to config.ts)
// These will be set from patronum.toml via the config module
const memoryBackend = () => (config as any).memoryBackend || "sqlite";
const shadowRead = () => (config as any).shadowRead === true;
const dualWrite = () => (config as any).dualWrite === true;

const AUTO_RECALL_TOP_K = 6;

/**
 * Auto-recall: given the user's message, find relevant past context.
 */
export async function autoRecall(userText: string): Promise<string | null> {
  try {
    const backend = memoryBackend();

    // Cognee path (Phase 2d) or shadow read (Phase 2b)
    if (backend === "cognee" || shadowRead()) {
      const cogneeUp = await health();
      if (cogneeUp && (backend === "cognee" || shadowRead())) {
        try {
          const results = await recall(userText, {
            topK: AUTO_RECALL_TOP_K,
            searchType: "CHUNKS",
            onlyContext: true,
          });

          if (results.length > 0) {
            const formatted = formatRecallResults(results);
            const context = `[Memory — relevant past context]\n\n${formatted}`;

            // If shadow read, also log comparison
            if (shadowRead() && backend !== "cognee") {
              // Fire and forget SQLite recall for comparison
              try {
                const queryVec = await embedQuery(userText);
                const sqliteResults = searchChunks(queryVec, { topK: AUTO_RECALL_TOP_K });
                logShadowComparison(userText, results, sqliteResults);
              } catch { /* non-fatal */ }
            }

            return context;
          }
        } catch (err) {
          console.error("[recall] Cognee recall failed, falling back to SQLite:", err);
          // Fall through to SQLite fallback
        }
      }
    }

    // SQLite path (legacy or fallback)
    const queryVec = await embedQuery(userText);
    const results = searchChunks(queryVec, { topK: AUTO_RECALL_TOP_K });

    if (results.length === 0) return null;

    const formatted = results
      .map((r, i) => `[${i + 1}] ${r.chunkText}`)
      .join("\n\n---\n\n");

    return `[Memory — relevant past context]\n\n${formatted}`;
  } catch (err) {
    console.error("[recall] Auto-recall failed:", err);
    return null;
  }
}

/**
 * Index a conversation exchange into the vector store(s).
 * Routes to Cognee when dual_write or backend=cognee.
 */
export async function indexExchange(
  chatId: string,
  userText: string,
  assistantMessages: Message[],
  turnNumber?: number
): Promise<void> {
  try {
    const chunkText = formatExchange(userText, assistantMessages);

    // Skip very short/empty exchanges
    if (chunkText.length < 20) return;

    const backend = memoryBackend();
    const isDualWrite = dualWrite();
    const isCogneePrimary = backend === "cognee";

    // Always write to SQLite for legacy/backup
    const [embedding] = await embed([chunkText]);
    storeChunk(chatId, chunkText, embedding, { turnNumber });

    // Write to Cognee if dual-write or Cognee primary
    if (isDualWrite || isCogneePrimary) {
      try {
        if (await health()) {
          const metadata = {
            source: "patronum",
            chat_id: chatId,
            timestamp: new Date().toISOString(),
            turn_number: turnNumber ?? 0,
          };

          // Use Python wrapper for metadata support (P1 workaround)
          await addWithMetadata(chunkText, metadata).catch(() => {
            // Fallback to simple add without metadata
            return add(chunkText);
          });

          // Fire-and-forget cognify (scheduled periodically instead)
          // Cognify is called by a scheduler, not per-turn (P5 finding)
        }
      } catch (err) {
        console.error("[recall] Cognee store failed:", err);
        // Non-fatal — SQLite already has the data
      }
    }

    console.log(`[recall] Indexed exchange (${chunkText.length} chars) for chat=${chatId}`);
  } catch (err) {
    console.error("[recall] Failed to index exchange:", err);
  }
}

/**
 * Log shadow comparison data for quality evaluation.
 */
function logShadowComparison(
  query: string,
  cogneeResults: any[],
  sqliteResults: MemorySearchResult[]
): void {
  const overlap = cogneeResults.filter(cr =>
    sqliteResults.some(sr => sr.chunkText === cr.text)
  ).length;

  const entry = {
    timestamp: new Date().toISOString(),
    query,
    cognee_count: cogneeResults.length,
    sqlite_count: sqliteResults.length,
    overlap,
    cognee_latency_ms: 0, // Filled by caller if measured
    sqlite_latency_ms: 0,
  };

  // Write to a log file for later analysis
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const logFile = path.join(config.workspace, "logs", "shadow-read-metrics.jsonl");
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

function formatExchange(userText: string, assistantMessages: Message[]): string {
  const parts: string[] = [`User: ${userText}`];

  for (const msg of assistantMessages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const textParts: string[] = [];
      const toolNames: string[] = [];

      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          const tb = block as ToolUseBlock;
          toolNames.push(tb.name);
        }
      }

      if (textParts.length > 0) {
        parts.push(`Assistant: ${textParts.join("\n")}`);
      }
      if (toolNames.length > 0) {
        parts.push(`[tools: ${toolNames.join(", ")}]`);
      }
    } else if (msg.role === "assistant" && typeof msg.content === "string") {
      parts.push(`Assistant: ${msg.content}`);
    }
  }

  return parts.join("\n");
}
