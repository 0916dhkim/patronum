/**
 * Memory tools exposed to the agent:
 * - memory_search: explicit semantic search with optional filters
 * - memory_write: index curated facts to the vector store
 */

import { embedQuery } from "./embeddings.js";
import { searchChunks, getChunkCount, getChunkById } from "./store.js";
import { indexCuratedFact } from "./recall.js";
import { getAdjacentMessages } from "../session.js";
import type { ToolHandler } from "../types.js";

export const memorySearchTool: ToolHandler = {
  definition: {
    name: "memory_search",
    description:
      "Search your memory for relevant past conversations and curated facts. " +
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
        type: {
          type: "string",
          enum: ["conversation", "curated", "all"],
          description: "Filter by chunk type (default: all)",
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
    const chunkType = input.type === "all" ? undefined : (input.type as string | undefined);

    const queryVec = await embedQuery(query);
    const results = searchChunks(queryVec, {
      topK,
      chatId,
      chunkType,
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
          `[${i + 1}] (${r.chunkType} | ${r.createdAt} | dist: ${r.distance.toFixed(3)})\n${r.chunkText}`
      )
      .join("\n\n---\n\n");

    return `Found ${results.length} relevant memories:\n\n${formatted}`;
  },
};

export const memoryWriteTool: ToolHandler = {
  definition: {
    name: "memory_write",
    description:
      "Index a curated fact for semantic search. Use this to save important information, " +
      "preferences, decisions, or lessons learned that should persist across sessions.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "The fact to remember — be concise and specific",
        },
      },
      required: ["fact"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const fact = input.fact as string;

    // Index the fact to the vector store
    await indexCuratedFact(fact);

    return `Indexed fact for semantic search.`;
  },
};

export const memoryFetchContextTool: ToolHandler = {
  definition: {
    name: "memory_fetch_context",
    description:
      "Fetch the conversation surrounding a recalled memory chunk. " +
      "Use this when a memory_search result looks relevant but you need temporal context " +
      "to judge whether it's still current.",
    input_schema: {
      type: "object",
      properties: {
        chunk_id: {
          type: "number",
          description: "The chunk ID from a previous memory_search result (required)",
        },
        window: {
          type: "number",
          description: "Number of messages to fetch before/after the chunk (default: 3, max: 10)",
        },
      },
      required: ["chunk_id"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const chunkId = input.chunk_id as number;
    const window = Math.min((input.window as number) || 3, 10);

    // Look up the chunk
    const chunk = getChunkById(chunkId);
    if (!chunk) {
      return `Chunk #${chunkId} not found in memory.`;
    }

    // Fetch adjacent messages
    const messages = getAdjacentMessages(chunk.chatId, chunk.createdAt, window);

    if (!messages) {
      return `Messages around this chunk have been compacted and are no longer available. The memory chunk (from ${chunk.createdAt}) is: "${chunk.chunkText}"`;
    }

    // Format as a compact transcript with timestamps
    const transcript = messages
      .map((msg) => `[${msg.createdAt}] ${msg.role === "user" ? "User" : "Assistant"}: ${msg.text}`)
      .join("\n\n");

    return `Context around memory chunk #${chunkId} (from ${chunk.createdAt}):\n\n${transcript}`;
  },
};
