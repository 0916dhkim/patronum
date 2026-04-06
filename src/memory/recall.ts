/**
 * Auto-recall orchestration.
 * Handles the full loop: embed query → search → format context.
 * Also handles post-turn indexing of new exchanges.
 */

import { embed, embedQuery } from "./embeddings.js";
import { storeChunk, searchChunks, type MemorySearchResult } from "./store.js";
import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from "../types.js";

const AUTO_RECALL_TOP_K = 6;

/**
 * Auto-recall: given the user's message, find relevant past context.
 * Returns a formatted string to attach to the current turn, or null if nothing found.
 */
export async function autoRecall(userText: string): Promise<string | null> {
  try {
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
 * Index a conversation exchange (user message + assistant response) into the vector store.
 * Called after each completed turn.
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

    const [embedding] = await embed([chunkText]);
    storeChunk(chatId, chunkText, embedding, {
      turnNumber,
      chunkType: "conversation",
    });

    console.log(`[recall] Indexed exchange (${chunkText.length} chars) for chat=${chatId}`);
  } catch (err) {
    console.error("[recall] Failed to index exchange:", err);
    // Non-fatal — don't break the main flow
  }
}

/**
 * Index a curated memory fact for persistent semantic search.
 */
export async function indexCuratedFact(fact: string): Promise<void> {
  try {
    const [embedding] = await embed([fact]);
    storeChunk("system", fact, embedding, { chunkType: "curated" });
    console.log(`[recall] Indexed curated fact (${fact.length} chars)`);
  } catch (err) {
    console.error("[recall] Failed to index fact:", err);
  }
}

/**
 * Format a user+assistant exchange into a compact chunk for embedding.
 */
function formatExchange(userText: string, assistantMessages: Message[]): string {
  const parts: string[] = [`User: ${userText}`];

  // Extract assistant text and tool summaries
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
    // Skip user messages (tool results) — we just note tool names above
  }

  return parts.join("\n");
}
