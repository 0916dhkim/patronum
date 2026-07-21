import { callLLM, getContextWindow as getProviderContextWindow } from "./providers/index.js";
import type { Message } from "./types.js";

// ---------------------------------------------------------------------------
// Compaction configuration
// ---------------------------------------------------------------------------

// Compaction triggers at 70% of the active model's validated context window.
// The 30% headroom accounts for output tokens, tool-call growth between
// trigger and next API call, and tokenizer variance.
const COMPACTION_THRESHOLD_RATIO = 0.70;

// Keep last ~20 messages verbatim during compaction.
const KEEP_RECENT_COUNT = 20;

// Per-block text truncation limits for the text representation fed to the summarizer.
const MAX_TEXT_SNIPPET_CHARS = 800;
const MAX_TOOL_INPUT_CHARS = 400;
const MAX_TOOL_RESULT_CHARS = 400;

// Max output tokens for each summarization / merge LLM call.
const MAX_SUMMARY_OUTPUT_TOKENS = 2048;

// Conservative chars-per-token bound. A value of 1 means "at most 1 token per
// character" — the worst case for dense tokenizers (CJK text, code, JSON with
// many special characters). This is genuinely conservative: even if every
// character in a transcript chunk is its own token, the chunk will not exceed
// the model's context window. English text typically tokenizes at ~3–4
// chars/token, so real usage will be well under budget — the cost of this
// conservatism is smaller chunk sizes (more summarization calls), not
// correctness.
const CHARS_PER_TOKEN = 1;

// Safety margin in tokens reserved for system prompt overhead, framing text,
// and tokenizer variance. Applied to both summarization and merge budget
// calculations.
const SAFETY_MARGIN_TOKENS = 5000;

// Minimum context window (in tokens) required for compaction to be safe.
// Below this, there is not enough room for system prompt + output + safety
// margin, so compaction must be skipped.
const MIN_USABLE_CONTEXT_TOKENS = 10_000;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

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

const PROGRESSIVE_MERGE_PROMPT = `You are merging multiple sequential summaries of an agent conversation into one cohesive summary.
Each chunk summary covers an earlier portion of the conversation, in order.

Merge them into a single structured markdown summary using exactly these sections, in this order:

## Current Objective
## Important Context
## Decisions Made
## Open Issues
## Active Files And Components
## Pending Next Steps

Requirements:
- Resolve any conflicts by preferring information from later chunks (they are more recent).
- Deduplicate redundant information.
- Be concise but preserve all continuation-critical context.
- Output only the merged markdown summary.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the context window size for a model using the provider abstraction.
 * For Anthropic models, queries the Anthropic models API.
 * For OpenRouter models, queries the OpenRouter model metadata API with
 * caching and a local fallback table; throws if the model cannot be resolved
 * (no silent arbitrary fallback for unknown models).
 */
export async function getContextWindow(model: string): Promise<number> {
  return getProviderContextWindow(model);
}

/**
 * Validate that a context window is large enough for safe compaction.
 *
 * Returns true if the window has enough room for the system prompt,
 * max output, and safety margin.  Returns false if the window is too
 * small or invalid (<= 0).
 *
 * Exported for testing.
 */
export function isContextWindowUsable(contextWindow: number): boolean {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;

  const systemPromptChars = COMPACTION_SYSTEM_PROMPT.length;
  const estimatedSystemPromptTokens = Math.ceil(systemPromptChars / CHARS_PER_TOKEN);

  const usableTokens =
    contextWindow - estimatedSystemPromptTokens - MAX_SUMMARY_OUTPUT_TOKENS - SAFETY_MARGIN_TOKENS;

  return usableTokens >= MIN_USABLE_CONTEXT_TOKENS;
}

/**
 * Compute the safe per-chunk character budget for transcript splitting.
 *
 * Formula:
 *   availableTokens = contextWindow - systemPromptTokens - maxOutputTokens - safetyMargin
 *   chunkChars     = availableTokens * CHARS_PER_TOKEN
 *
 * With CHARS_PER_TOKEN = 1, chunkChars equals availableTokens. This means
 * even if every character in the chunk is its own token (CJK, code, JSON),
 * the total LLM call (system prompt + chunk + output) stays within the
 * context window.
 *
 * The output NEVER exceeds the safe usable context — if the window is too
 * small, this function throws so the caller can skip compaction.
 *
 * Exported for testing.
 */
export function computeChunkCharBudget(contextWindow: number): number {
  if (!isContextWindowUsable(contextWindow)) {
    throw new Error(
      `[compaction] Context window ${contextWindow} is too small for safe compaction ` +
        `(requires at least ${MIN_USABLE_CONTEXT_TOKENS} usable tokens after overhead) — skipping`
    );
  }

  const systemPromptChars = COMPACTION_SYSTEM_PROMPT.length;
  const estimatedSystemPromptTokens = Math.ceil(systemPromptChars / CHARS_PER_TOKEN);

  const availableTokens =
    contextWindow -
    estimatedSystemPromptTokens -
    MAX_SUMMARY_OUTPUT_TOKENS -
    SAFETY_MARGIN_TOKENS;

  return Math.floor(availableTokens * CHARS_PER_TOKEN);
}

/**
 * Compute the maximum number of chunk summaries that can be safely merged
 * in a single LLM call.
 *
 * The merge call receives all chunk summaries concatenated plus a system prompt.
 * Each chunk summary is at most MAX_SUMMARY_OUTPUT_TOKENS tokens.
 *
 * Throws if the context window is too small for even a single chunk summary.
 *
 * Exported for testing.
 */
export function computeMaxMergeChunks(contextWindow: number): number {
  const mergeSystemPromptChars = PROGRESSIVE_MERGE_PROMPT.length;
  const estimatedMergeSystemTokens = Math.ceil(mergeSystemPromptChars / CHARS_PER_TOKEN);

  // Each chunk summary is at most MAX_SUMMARY_OUTPUT_TOKENS tokens
  const maxSummaryTokensPerChunk = MAX_SUMMARY_OUTPUT_TOKENS;

  const availableMergeTokens =
    contextWindow -
    estimatedMergeSystemTokens -
    MAX_SUMMARY_OUTPUT_TOKENS -
    SAFETY_MARGIN_TOKENS;

  if (availableMergeTokens <= 0) {
    throw new Error(
      `[compaction] Context window ${contextWindow} too small for merge — ` +
        `requires at least ${estimatedMergeSystemTokens + MAX_SUMMARY_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS} tokens`
    );
  }

  return Math.max(1, Math.floor(availableMergeTokens / maxSummaryTokensPerChunk));
}

/**
 * Compute the safe character budget for merge input — the maximum total
 * character length of all summaries fed into a single merge LLM call
 * (excluding the merge system prompt and output budget).
 *
 * With CHARS_PER_TOKEN = 1, the char budget equals the available merge tokens.
 * This ensures that even if every character in the concatenated summaries is
 * its own token (worst-case dense tokenization), the merge call stays within
 * the model's context window.
 *
 * Throws if the context window is too small for safe merging.
 *
 * Exported for testing.
 */
export function computeMergeInputCharBudget(contextWindow: number): number {
  if (!isContextWindowUsable(contextWindow)) {
    throw new Error(
      `[compaction] Context window ${contextWindow} is too small for safe merge — skipping`
    );
  }

  const mergeSystemPromptChars = PROGRESSIVE_MERGE_PROMPT.length;
  const estimatedMergeSystemTokens = Math.ceil(mergeSystemPromptChars / CHARS_PER_TOKEN);

  const availableMergeTokens =
    contextWindow -
    estimatedMergeSystemTokens -
    MAX_SUMMARY_OUTPUT_TOKENS -
    SAFETY_MARGIN_TOKENS;

  if (availableMergeTokens <= 0) {
    throw new Error(
      `[compaction] Context window ${contextWindow} too small for merge — ` +
        `requires at least ${estimatedMergeSystemTokens + MAX_SUMMARY_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS} tokens`
    );
  }

  return Math.floor(availableMergeTokens * CHARS_PER_TOKEN);
}

/**
 * Check if a message is a user message containing tool_result blocks.
 */
function isToolResultMessage(msg: Message): boolean {
  return (
    msg.role === "user" &&
    Array.isArray(msg.content) &&
    msg.content.some((b) => b.type === "tool_result")
  );
}

/**
 * Find a safe split index that preserves tool_use/tool_result boundaries.
 *
 * Scans backward from the initial split to find the nearest clean boundary:
 * a user message that does NOT contain tool_result blocks. This ensures
 * entire tool-use conversations are either summarized or kept intact, and
 * that toKeep starts with a valid conversation start (user message without
 * orphaned tool_results).
 *
 * Returns 0 if no clean boundary is found (caller should skip compaction).
 *
 * Exported for testing.
 */
export function findSafeSplitIndex(messages: Message[], initialSplit: number): number {
  let splitIndex = initialSplit;

  // Clamp to valid range
  if (splitIndex <= 0) return 0;
  if (splitIndex >= messages.length) splitIndex = messages.length - 1;

  // Scan backward to find a clean user message boundary
  while (splitIndex > 0) {
    const msg = messages[splitIndex];

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        // Plain text user message — clean boundary
        return splitIndex;
      }
      if (
        Array.isArray(msg.content) &&
        !msg.content.some((b) => b.type === "tool_result")
      ) {
        // User message with no tool_result — clean boundary
        return splitIndex;
      }
    }

    // Not a clean boundary — move back
    splitIndex--;
  }

  // Reached index 0 without finding a clean boundary
  return 0;
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text representation of a message for summarization.
 * Skips thinking blocks and redacted thinking blocks — they are ephemeral
 * and should not be included in compaction summaries.
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

    // tool_result blocks — preserve explicitly for boundary data
    if (block.type === "tool_result") {
      const status = block.is_error ? "error" : "ok";
      parts.push(
        `- Tool result (${status}): ${truncateText(normalizeWhitespace(typeof block.content === "string" ? block.content : "[image content]"), MAX_TOOL_RESULT_CHARS)}`
      );
      continue;
    }
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

// ---------------------------------------------------------------------------
// LLM summarization
// ---------------------------------------------------------------------------

/**
 * Summarize a single transcript string using the session model.
 * Throws on empty/invalid response — never returns a placeholder string.
 * This ensures the caller takes the safe path (preserve original history).
 */
async function summarizeTranscript(
  transcript: string,
  isPartial: boolean,
  model: string
): Promise<string> {
  const userContent = isPartial
    ? `Summarize this portion of an earlier conversation transcript for future continuation:\n\n${transcript}`
    : `Summarize this earlier conversation transcript for future continuation:\n\n${transcript}`;

  const response = await callLLM(
    [{ role: "user", content: userContent }],
    model,
    [{ type: "text", text: COMPACTION_SYSTEM_PROMPT }],
    [],
    { maxTokens: MAX_SUMMARY_OUTPUT_TOKENS }
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text?.trim() : "";
  if (!text) {
    throw new Error(
      "[compaction] summarizeTranscript: model returned empty or no-text response — refusing to replace history with invalid summary"
    );
  }
  return text;
}

/**
 * Merge multiple chunk summaries into one using the session model.
 * Throws on empty/invalid response — never returns a placeholder string.
 */
async function mergeChunkSummaries(chunkSummaries: string[], model: string): Promise<string> {
  const merged = chunkSummaries
    .map((s, i) => `### Chunk ${i + 1} Summary\n${s}`)
    .join("\n\n");

  const response = await callLLM(
    [{ role: "user", content: `Merge these sequential conversation summaries:\n\n${merged}` }],
    model,
    [{ type: "text", text: PROGRESSIVE_MERGE_PROMPT }],
    [],
    { maxTokens: MAX_SUMMARY_OUTPUT_TOKENS }
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text?.trim() : "";
  if (!text) {
    throw new Error(
      "[compaction] mergeChunkSummaries: model returned empty or no-text response — refusing to replace history with invalid merge result"
    );
  }
  return text;
}

/**
 * Hierarchical/batched merge: group summaries by a safe merge input budget,
 * merge each group, repeat until one final summary remains.
 *
 * Preserves chronological order: summaries are grouped in order, and within
 * each group the merge prompt presents them as Chunk 1, Chunk 2, … in order.
 *
 * If any merge call fails or yields empty text, the error propagates to the
 * caller (compactIfNeeded catches it and preserves live history unchanged).
 *
 * @param summaries       Summary strings in chronological order
 * @param model           The active session model (no alternate/fallback)
 * @param mergeCharBudget Safe max total chars for merge input (from
 *                        computeMergeInputCharBudget). Each summary's
 *                        character length plus framing overhead is counted
 *                        against this budget.
 */
async function hierarchicalMerge(
  summaries: string[],
  model: string,
  mergeCharBudget: number
): Promise<string> {
  let current = summaries;
  let round = 0;

  while (current.length > 1) {
    round++;

    // Group summaries by char budget, preserving chronological order.
    // Each summary in a merge group has framing overhead:
    //   "### Chunk N Summary\n" — generous upper bound ~30 chars.
    const FRAMING_OVERHEAD = 30;
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    let currentGroupChars = 0;

    for (const summary of current) {
      const summaryCost = summary.length + FRAMING_OVERHEAD;

      if (currentGroup.length > 0 && currentGroupChars + summaryCost > mergeCharBudget) {
        // Current group is full — start a new one
        groups.push(currentGroup);
        currentGroup = [];
        currentGroupChars = 0;
      }

      currentGroup.push(summary);
      currentGroupChars += summaryCost;
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    console.log(
      `[compaction] Merge round ${round}: ${current.length} summaries → ${groups.length} group(s) ` +
        `(budget: ${mergeCharBudget} chars)`
    );

    // Safety: if every group has exactly 1 summary, we cannot make progress.
    // This means the merge budget is too small for even 2 summaries.
    // isContextWindowUsable should prevent this, but guard against infinite loops.
    if (groups.length === current.length) {
      throw new Error(
        `[compaction] Merge budget (${mergeCharBudget} chars) too small to merge any summaries — ` +
          `cannot make progress. Context window may be too small for hierarchical merge.`
      );
    }

    // Merge each group. Groups with a single summary pass through unchanged.
    // Promise.all preserves array order so chronological order is maintained.
    current = await Promise.all(
      groups.map((group) => {
        if (group.length === 1) {
          return Promise.resolve(group[0]);
        }
        return mergeChunkSummaries(group, model);
      })
    );
  }

  return current[0];
}

/**
 * Summarize a set of messages, splitting into chunks if the transcript
 * would exceed the model's context window. Uses hierarchical/batched merge
 * to combine chunk summaries into one final summary.
 *
 * Chunk size is computed dynamically from the model's context window,
 * accounting for system prompt tokens, max output tokens, and a safety margin.
 * The merge input budget is also computed dynamically so that no merge call
 * is ever oversized.
 *
 * If any summarization or merge step fails (throws or yields empty text),
 * the error propagates to compactIfNeeded, which preserves the original
 * live history unchanged.
 */
async function summarizeMessages(
  messages: Message[],
  model: string,
  contextWindow: number
): Promise<string> {
  const chunkCharBudget = computeChunkCharBudget(contextWindow);
  const mergeCharBudget = computeMergeInputCharBudget(contextWindow);

  const messageTexts = messages.map(messageToText);

  // Build chunks that fit within the computed budget
  const chunks: string[] = [];
  let currentChunk = "";

  for (const text of messageTexts) {
    const separator = currentChunk ? "\n\n" : "";
    if (
      currentChunk &&
      currentChunk.length + separator.length + text.length > chunkCharBudget
    ) {
      chunks.push(currentChunk);
      currentChunk = text;
    } else {
      currentChunk = currentChunk + separator + text;
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  console.log(
    `[compaction] Summarizing ${messages.length} messages in ${chunks.length} chunk(s) ` +
      `(chunk budget: ${chunkCharBudget} chars, merge budget: ${mergeCharBudget} chars)`
  );

  if (chunks.length === 1) {
    return summarizeTranscript(chunks[0], false, model);
  }

  // Summarize each chunk in parallel (order preserved by Promise.all)
  const chunkSummaries = await Promise.all(
    chunks.map((chunk, i) => {
      console.log(
        `[compaction] Summarizing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`
      );
      return summarizeTranscript(chunk, true, model);
    })
  );

  // Hierarchical merge: group summaries by safe merge input budget,
  // merge each group, repeat until one final summary. This ensures
  // no merge call is ever oversized.
  console.log(`[compaction] Hierarchical merge of ${chunkSummaries.length} summaries`);
  return hierarchicalMerge(chunkSummaries, model, mergeCharBudget);
}

// ---------------------------------------------------------------------------
// Main compaction entry point
// ---------------------------------------------------------------------------

/**
 * Token-based compaction: triggers when input_tokens >= 70% of the active
 * model's validated context window.
 *
 * Keeps the last KEEP_RECENT_COUNT messages verbatim, summarizes the rest
 * with the same session model (no alternate compaction model or fallback).
 * Uses progressive chunked summarization with dynamic chunk sizing.
 *
 * Safety guarantees:
 * - Never replaces live history after empty/invalid summary or merge result.
 *   On any summarization error, returns the original messages unchanged.
 * - Preserves tool-result boundary data: scans backward to find a clean split
 *   point that doesn't orphan tool_result messages.
 * - Skips thinking blocks during summarization (preserves existing semantics).
 *
 * @param messages  Full conversation history (in-memory, pre-persistence)
 * @param inputTokens  Token count from the most recent API call (message_start
 *                     for Anthropic, message_delta for OpenRouter)
 * @param model  The active session model — same model used for runAgentStreaming
 * @returns Compacted messages if compaction occurred, or original messages otherwise
 */
export async function compactIfNeeded(
  messages: Message[],
  inputTokens: number,
  model: string
): Promise<{ messages: Message[]; compacted: boolean }> {
  let contextWindow: number;
  try {
    contextWindow = await getContextWindow(model);
  } catch (err) {
    console.error(
      `[compaction] Failed to resolve context window for ${model} — skipping compaction:`,
      err instanceof Error ? err.message : err
    );
    return { messages, compacted: false };
  }

  const threshold = Math.floor(contextWindow * COMPACTION_THRESHOLD_RATIO);

  console.log(
    `[compaction] Token usage: ${inputTokens}/${contextWindow} tokens ` +
      `(threshold: ${threshold} = ${Math.round(COMPACTION_THRESHOLD_RATIO * 100)}%)`
  );

  if (inputTokens < threshold) {
    return { messages, compacted: false };
  }

  // Validate that the context window is large enough for safe compaction.
  // If not, skip with an observable log rather than producing chunks that
  // exceed the safe usable context.
  if (!isContextWindowUsable(contextWindow)) {
    console.warn(
      `[compaction] Context window ${contextWindow} is too small for safe compaction — skipping`
    );
    return { messages, compacted: false };
  }

  console.log(
    `[compaction] Threshold reached (${inputTokens} >= ${threshold} tokens) — compacting...`
  );

  // Split: summarize older messages, keep recent ones verbatim
  const initialSplitIndex = Math.max(0, messages.length - KEEP_RECENT_COUNT);

  // Find a safe split point that preserves tool_use/tool_result boundaries.
  // Scans backward from initialSplitIndex to the nearest clean user message.
  const splitIndex = findSafeSplitIndex(messages, initialSplitIndex);

  // Ensure we have at least something to summarize
  if (splitIndex === 0) {
    console.log(`[compaction] Not enough messages to split cleanly — skipping`);
    return { messages, compacted: false };
  }

  const toSummarize = messages.slice(0, splitIndex);
  const toKeep = messages.slice(splitIndex);

  // Post-compaction defensive assertion: verify toKeep starts with a valid
  // conversation start (user message without tool_result). findSafeSplitIndex
  // should guarantee this, but if it somehow fails, skip compaction rather
  // than risk silent data loss.
  if (toKeep.length > 0 && isToolResultMessage(toKeep[0])) {
    console.error(
      `[compaction] Defensive check failed: toKeep[0] is tool_result after findSafeSplitIndex — ` +
        `skipping compaction to preserve data`
    );
    return { messages, compacted: false };
  }

  console.log(
    `[compaction] Split at index ${splitIndex} ` +
      `(initial=${initialSplitIndex}, summarized=${toSummarize.length}, kept=${toKeep.length})`
  );

  // Summarize with error handling — never replace history on failure.
  // On error, return original messages so the next turn can retry.
  let summary: string;
  try {
    summary = await summarizeMessages(toSummarize, model, contextWindow);
  } catch (err) {
    console.error(
      `[compaction] Summarization failed — preserving original history:`,
      err instanceof Error ? err.message : err
    );
    return { messages, compacted: false };
  }

  // Double-check summary is non-empty (summarizeTranscript already throws,
  // but this is a belt-and-suspenders guard against logic errors)
  if (!summary || !summary.trim()) {
    console.error(`[compaction] Summary is empty — preserving original history`);
    return { messages, compacted: false };
  }

  console.log(
    `[compaction] Summarized ${toSummarize.length} messages into ~${summary.length} chars`
  );

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
