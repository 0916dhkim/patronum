/**
 * Memory tools exposed to the agent:
 * - memory_search: explicit semantic search with optional filters
 * - memory_write: append/edit curated facts in MEMORY.md
 */

import fs from "node:fs";
import path from "node:path";
import { embedQuery } from "./embeddings.js";
import { searchChunks, getChunkCount } from "./store.js";
import { indexFact } from "./recall.js";
import { config } from "../config.js";
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
      "Write a curated fact to MEMORY.md. Use this to save important information, " +
      "preferences, decisions, or lessons learned that should persist across sessions. " +
      "The fact is also indexed for semantic search.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "The fact to remember — be concise and specific",
        },
        section: {
          type: "string",
          description:
            "Optional section header to place the fact under (e.g. 'Preferences', 'Infrastructure'). " +
            "If the section exists, the fact is appended to it. Otherwise appended at the end.",
        },
      },
      required: ["fact"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const fact = input.fact as string;
    const section = input.section as string | undefined;

    const memoryPath = path.join(config.workspace, "MEMORY.md");

    // Read existing content or start fresh
    let content: string;
    try {
      content = fs.readFileSync(memoryPath, "utf-8");
    } catch {
      content = "# MEMORY.md\n\nCurated facts and persistent context.\n";
    }

    if (section) {
      // Try to find the section and append under it
      const sectionHeader = `## ${section}`;
      const idx = content.indexOf(sectionHeader);

      if (idx !== -1) {
        // Find the end of this section (next ## or end of file)
        const afterHeader = idx + sectionHeader.length;
        const nextSection = content.indexOf("\n## ", afterHeader);
        const insertAt = nextSection !== -1 ? nextSection : content.length;

        content =
          content.slice(0, insertAt).trimEnd() +
          `\n- ${fact}\n` +
          content.slice(insertAt);
      } else {
        // Create the section at the end
        content = content.trimEnd() + `\n\n## ${section}\n- ${fact}\n`;
      }
    } else {
      // Append at the end
      content = content.trimEnd() + `\n- ${fact}\n`;
    }

    fs.writeFileSync(memoryPath, content, "utf-8");

    // Also index the fact for vector search
    await indexFact("system", fact);

    return `Saved to MEMORY.md${section ? ` (section: ${section})` : ""} and indexed for search.`;
  },
};
