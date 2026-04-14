import { config } from "./config.js";
import type { Message, ContentBlock } from "./types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_API_URL = "https://api.anthropic.com/v1/models";
const COMPACTION_MODEL = "claude-haiku-4-5-20251001";

// Compaction triggers at 70% of the model's context window
const COMPACTION_RATIO = 0.70;

// Keep last ~20 messages verbatim during compaction
const KEEP_RECENT_COUNT = 20;
const MAX_TEXT_SNIPPET_CHARS = 800;
const MAX_TOOL_INPUT_CHARS = 400;
const MAX_TOOL_RESULT_CHARS = 400;

const COMPACTION_SYSTEM_PROMPT = `You compact long-running agent conversations into a continuation-safe state summary.

Summarize the provided transcript into structured markdown using exactly these sections, in this order:

## Current Objective
## Important Context
## Decisions Made
## Open Issues
## Active Files And Components
## Pending Next Steps

Requirements:
- Preserve the active goal, relevant user preferences, important facts, decisions, unresolved questions, and pending work.
- Preserve meaningful tool outcomes, errors, and any tool result that changed the direction of the work.
- Mention concrete files, functions, components, or external identifiers when they are still relevant.
- Prefer explicit unknowns over guesses.
- Be concise, but do not omit continuation-critical context.
- Use bullets where helpful inside sections.
- Output only the markdown summary.`;

// Cache: model id → context_window size
const contextWindowCache = new Map<string, number>();

// Fallback context windows for common models
const FALLBACK_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-20250514": 200_000,
};

/**
 * Fetch the context window size for a model from the Anthropic models API.
 * Caches results in memory.
 */
export async function getContextWindow(model: string): Promise<number> {
  const cached = contextWindowCache.get(model);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(`${MODELS_API_URL}/${model}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.claudeToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "user-agent": "claude-cli/2.1.85",
        "content-type": "application/json",
      },
    });

    if (response.ok) {
      const data = (await response.json()) as { context_window?: number };
      if (data.context_window) {
        contextWindowCache.set(model, data.context_window);
        console.log(`[compaction] Cached context window for ${model}: ${data.context_window}`);
        return data.context_window;
      }
    } else {
      console.warn(`[compaction] Models API returned ${response.status} for ${model}, using fallback`);
    }
  } catch (err) {
    console.warn(`[compaction] Failed to fetch context window for ${model}:`, err);
  }

  // Fallback
  const fallback = FALLBACK_CONTEXT_WINDOWS[model] ?? 200_000;
  contextWindowCache.set(model, fallback);
  console.log(`[compaction] Using fallback context window for ${model}: ${fallback}`);
  return fallback;
}

/**
 * Extract plain text representation of a message for summarization
 */
function messageToText(msg: Message): string {
  const role = msg.role.toUpperCase();
  if (typeof msg.content === "string") {
    return [`### ${role} MESSAGE`, truncateText(msg.content, MAX_TEXT_SNIPPET_CHARS)].join("\n");
  }

  const parts: string[] = [`### ${role} MESSAGE`];
  for (const block of msg.content) {
    if (block.type === "text") {
      const text = normalizeWhitespace(block.text);
      if (text) parts.push(`- Text: ${truncateText(text, MAX_TEXT_SNIPPET_CHARS)}`);
      continue;
    }

    if (block.type === "tool_use") {
      parts.push(
        `- Tool call: ${block.name}(${truncateText(safeJson(block.input), MAX_TOOL_INPUT_CHARS)})`
      );
      continue;
    }

    if (block.type === "image") {
      parts.push(`- Image (base64, omitted)`);
      continue;
    }

    if (block.type === "thinking") {
      // Skip thinking blocks — don't include in compaction summaries
      continue;
    }

    if (block.type === "redacted_thinking") {
      // Skip redacted thinking blocks
      continue;
    }

    const status = block.is_error ? "error" : "ok";
    parts.push(
      `- Tool result (${status}): ${truncateText(normalizeWhitespace(typeof block.content === "string" ? block.content : "[image content]"), MAX_TOOL_RESULT_CHARS)}`
    );
  }
  return parts.join("\n");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable input]";
  }
}

/**
 * Call Claude (Haiku) to summarize a set of messages
 */
async function summarizeMessages(messages: Message[]): Promise<string> {
  const transcript = messages.map(messageToText).join("\n\n");

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
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Summarize this earlier conversation transcript for future continuation:\n\n${transcript}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Compaction API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  return data.content.find((b) => b.type === "text")?.text ?? "(summary unavailable)";
}

/**
 * Token-based compaction: triggers when input_tokens / context_window >= 70%.
 * Keeps the last KEEP_RECENT_COUNT messages verbatim, summarizes the rest with Haiku.
 * Returns the (possibly compacted) message array.
 */
export async function compactIfNeeded(
  messages: Message[],
  inputTokens: number,
  model: string
): Promise<{ messages: Message[]; compacted: boolean }> {
  const contextWindow = await getContextWindow(model);
  const ratio = inputTokens / contextWindow;

  console.log(`[compaction] Token usage: ${inputTokens}/${contextWindow} (${(ratio * 100).toFixed(1)}%)`);

  if (ratio < COMPACTION_RATIO) {
    return { messages, compacted: false };
  }

  console.log(`[compaction] Threshold reached (${(ratio * 100).toFixed(1)}% >= ${COMPACTION_RATIO * 100}%) — compacting...`);

  // Split: summarize older messages, keep recent ones verbatim
  const initialSplitIndex = Math.max(0, messages.length - KEEP_RECENT_COUNT);
  let splitIndex = initialSplitIndex;

  // Adjust split point to avoid breaking tool_use/tool_result pairs.
  // If the message right after the split is a user message with tool_results,
  // move the split back to include the preceding assistant message too.
  if (splitIndex > 0 && splitIndex < messages.length) {
    const msgAfterSplit = messages[splitIndex];
    if (
      msgAfterSplit.role === "user" &&
      Array.isArray(msgAfterSplit.content) &&
      msgAfterSplit.content.some((b) => b.type === "tool_result")
    ) {
      // Include the assistant message with the matching tool_use blocks
      splitIndex = Math.max(0, splitIndex - 1);
    }
  }

  // Ensure we have at least something to summarize
  if (splitIndex === 0) {
    console.log(`[compaction] Not enough messages to split — skipping`);
    return { messages, compacted: false };
  }

  const toSummarize = messages.slice(0, splitIndex);
  let toKeep = messages.slice(splitIndex);

  // Safety: ensure toKeep doesn't start with a tool_result message (would be orphaned)
  while (
    toKeep.length > 0 &&
    toKeep[0].role === "user" &&
    Array.isArray(toKeep[0].content) &&
    toKeep[0].content.some((b) => b.type === "tool_result")
  ) {
    console.warn(`[compaction] Dropping leading tool_result message from toKeep to avoid orphan`);
    toKeep = toKeep.slice(1);
  }

  console.log(
    `[compaction] Split at index ${splitIndex} (initial=${initialSplitIndex}, summarized=${toSummarize.length}, kept=${toKeep.length})`
  );

  const summary = await summarizeMessages(toSummarize);

  console.log(`[compaction] Summarized ${toSummarize.length} messages into ~${summary.length} chars`);

  // Prepend summary as a system-style user message
  const summaryMessage: Message = {
    role: "user",
    content: `[Conversation summary — earlier context compacted]\n\n${summary}`,
  };

  // Assistant ack to keep message alternation valid
  const summaryAck: Message = {
    role: "assistant",
    content: "Understood. I have the context from the earlier conversation.",
  };

  const compactedMessages = [summaryMessage, summaryAck, ...toKeep];

  return { messages: compactedMessages, compacted: true };
}
