/**
 * Memory tools — Cognee-aware version.
 * Routes memory_search and memory_fetch_context to Cognee when backend=cognee.
 */

import { embedQuery } from "./embeddings.js";
import { searchChunks, getChunkCount } from "./store.js";
import { recall, formatRecallResults } from "./cognee_client.js";
import { health as cogneeHealth } from "./cognee_client.js";
import type { ToolHandler } from "../types.js";
import { config } from "../config.js";

const memoryBackend = () => (config as any).memoryBackend || "sqlite";

export const memorySearchTool: ToolHandler = {
  definition: {
    name: "memory_search",
    description:
      "Search your memory for relevant past conversations. " +
      "Use this to recall things discussed previously, look up decisions, or find context. " +
      "Supports optional time filtering and chat scoping.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Semantic search query — describe what you're looking for",
        },
        top_k: {
          type: "number",
          description: "Number of results to return (default: 8, max: 20)",
        },
        chat_id: {
          type: "string",
          description: "Optional: scope search to a specific chat",
        },
        after_date: {
          type: "string",
          description: "Optional: only return results after this date (YYYY-MM-DD)",
        },
        before_date: {
          type: "string",
          description: "Optional: only return results before this date (YYYY-MM-DD)",
        },
      },
      required: ["query"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const query = input.query as string;
    const topK = Math.min((input.top_k as number) || 8, 20);
    const chatId = input.chat_id as string | undefined;
    const afterDate = input.after_date as string | undefined;
    const beforeDate = input.before_date as string | undefined;

    // Cognee path — high-level recall (Cognee selects optimal retrieval strategy)
    if (memoryBackend() === "cognee") {
      const up = await cogneeHealth();
      if (up) {
        try {
          // High-level recall: minimal { query, datasets } request body.
          // No forced search_type/only_context/top_k — Cognee chooses strategy.
          const results = await recall(query);

          if (results.length === 0) {
            return `No relevant memories found for: "${query}"`;
          }

          // Client-side filtering note (Cognee REST API does not support date/chat_id filters)
          if (chatId || afterDate || beforeDate) {
            const filterNotes: string[] = [];
            if (chatId) filterNotes.push(`chat_id="${chatId}"`);
            if (afterDate) filterNotes.push(`after=${afterDate}`);
            if (beforeDate) filterNotes.push(`before=${beforeDate}`);
            const filterDesc = filterNotes.join(", ");

            return `Found ${results.length} relevant memories (WARNING: filter ${filterDesc} not applied — Cognee backend does not support client-side filtering yet):\n\n${formatRecallResults(results)}`;
          }

          return `Found ${results.length} relevant memories:\n\n${formatRecallResults(results)}`;
        } catch (err) {
          console.error("[memory_search] Cognee search failed, falling back:", err);
          // Fall through to SQLite
        }
      }
    }

    // SQLite path (legacy or fallback)
    const queryVec = await embedQuery(query);
    const results = searchChunks(queryVec, {
      topK,
      chatId,
      afterDate,
      beforeDate,
    });

    if (results.length === 0) {
      const total = getChunkCount();
      return `No relevant memories found for: "${query}" (${total} total chunks in memory)`;
    }

    const formatted = results
      .map(
        (r, i) =>
          `[${i + 1}] (${r.createdAt} | dist: ${r.distance.toFixed(3)})\n${r.chunkText}`
      )
      .join("\n\n---\n\n");

    return `Found ${results.length} relevant memories:\n\n${formatted}`;
  },
};
