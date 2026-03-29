import { config } from "./config.js";
import type { Message, ContentBlock } from "./types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_API_URL = "https://api.anthropic.com/v1/models";

// Compaction triggers at 70% of the model's context window
const COMPACTION_RATIO = 0.70;

// Keep last ~20 messages verbatim during compaction
const KEEP_RECENT_COUNT = 20;

// Cache: model id → context_window size
const contextWindowCache = new Map<string, number>();

// Fallback context windows for common models
const FALLBACK_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-haiku-3-5-20241022": 200_000,
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
    return `${role}: ${msg.content}`;
  }
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_use") parts.push(`[Tool: ${block.name}(${JSON.stringify(block.input)})]`);
    else if (block.type === "tool_result") parts.push(`[Tool result: ${block.content.slice(0, 500)}]`);
  }
  return `${role}: ${parts.join(" ")}`;
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
      model: "claude-haiku-3-5-20241022",
      max_tokens: 2048,
      system: "You are a precise summarizer. Summarize the conversation transcript below into a compact but complete summary. Preserve all key facts, decisions, code changes, and context that would be needed to continue the conversation. Be concise but thorough. Output only the summary, no preamble.",
      messages: [
        {
          role: "user",
          content: `Please summarize this conversation transcript:\n\n${transcript}`,
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
  let splitIndex = Math.max(0, messages.length - KEEP_RECENT_COUNT);

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
  const toKeep = messages.slice(splitIndex);

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
