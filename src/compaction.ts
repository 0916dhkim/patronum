import { config } from "./config.js";
import type { Message, ContentBlock } from "./types.js";

const API_URL = "https://api.anthropic.com/v1/messages";

// Token thresholds
const COMPACTION_THRESHOLD = 60_000; // trigger compaction above this many estimated tokens
const KEEP_RECENT_TOKENS = 20_000;   // always keep this many tokens of recent messages

/**
 * Rough token estimator: ~4 chars per token
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else {
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "tool_use") chars += JSON.stringify(block.input).length + block.name.length;
        else if (block.type === "tool_result") chars += block.content.length;
      }
    }
  }
  return Math.ceil(chars / 4);
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
 * Call Claude to summarize a set of messages
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
      model: config.claudeModel,
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
 * If the conversation is too long, compact older messages into a summary.
 * Returns the (possibly compacted) message array.
 */
export async function compactIfNeeded(messages: Message[]): Promise<{ messages: Message[]; compacted: boolean }> {
  const totalTokens = estimateTokens(messages);

  if (totalTokens <= COMPACTION_THRESHOLD) {
    return { messages, compacted: false };
  }

  console.log(`[compaction] Context ~${totalTokens} tokens — compacting...`);

  // Find the split point: keep recent messages up to KEEP_RECENT_TOKENS
  let recentTokens = 0;
  let splitIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    recentTokens += estimateTokens([messages[i]]);
    if (recentTokens >= KEEP_RECENT_TOKENS) {
      splitIndex = i + 1;
      break;
    }
    splitIndex = i;
  }

  // Ensure we have at least something to summarize
  if (splitIndex === 0) {
    splitIndex = Math.floor(messages.length / 2);
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

  // We need an assistant ack to keep message alternation valid
  const summaryAck: Message = {
    role: "assistant",
    content: "Understood. I have the context from the earlier conversation.",
  };

  const compactedMessages = [summaryMessage, summaryAck, ...toKeep];

  return { messages: compactedMessages, compacted: true };
}
