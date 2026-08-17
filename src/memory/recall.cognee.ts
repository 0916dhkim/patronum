/**
 * Auto-recall orchestration — Cognee-aware version.
 * Routes to Cognee when backend=cognee, falls back to SQLite otherwise.
 */

import { embed, embedQuery } from "./embeddings.js";
import { storeChunk, searchChunks, type MemorySearchResult } from "./store.js";
import {
  health,
  recall,
  formatRecallResults,
  rememberQaEntry,
  rememberTraceEntry,
  type CogneeTraceEntry,
} from "./cognee_client.js";
import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock, TextBlock } from "../types.js";
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
          // High-level recall: minimal { query, datasets } request body.
          // No forced search_type/only_context/top_k — Cognee chooses strategy.
          const results = await recall(userText);

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
 *
 * Memory redesign (plan v2): the Cognee write path is THREE-channel session-cache
 * capture — a typed QAEntry via rememberQaEntry(userText, assistantReplyText,
 * sessionId) plus per-tool-call TraceEntry rows via rememberTraceEntry (so
 * improve()'s agent-context extraction can distill agent lessons) — all
 * fire-and-forget, fail-open, no graph writes, no self-improvement at write
 * time. SQLite dual-write stays as the backup.
 *
 * sessionId is captured once at turn start in handleEvent (NOT recomputed here)
 * and identifies the day-scoped session: `chat:{chatId}:{YYYY-MM-DD}`.
 */
export async function indexExchange(
  chatId: string,
  userText: string,
  assistantMessages: Message[],
  turnNumber?: number,
  sessionId?: string
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

    // Write QA entry to the Cognee session cache if dual-write or Cognee primary.
    // Fire-and-forget + fail-open: never block or break the reply on Cognee issues.
    if ((isDualWrite || isCogneePrimary) && sessionId && userText.trim()) {
      // answer = final reply text (extractTextFromResponse result)
      const replyText = extractReplyText(assistantMessages);
      if (replyText && replyText !== "(no response)") {
        rememberQaEntry(userText, replyText, sessionId).catch((err) => {
          console.error(`[recall] Cognee rememberQaEntry failed (non-fatal) session=${sessionId}:`, err);
        });
      }

      // Three-channel capture: QA + traces. Persist per-tool-call TraceEntry
      // rows sequentially (await each; indexExchange is itself fire-and-forget
      // from the caller, so this never blocks the reply) so improve() can run
      // agent-context extraction → distill from trace-derived agent lessons.
      for (const step of collectTraceSteps(assistantMessages)) {
        try {
          await rememberTraceEntry(step, sessionId);
        } catch (err) {
          console.error(`[recall] Cognee rememberTraceEntry failed (non-fatal) session=${sessionId} fn=${step.origin_function}:`, err);
        }
      }
    }

    console.log(`[recall] Indexed exchange (${chunkText.length} chars) for chat=${chatId}${sessionId ? ` session=${sessionId}` : ""}`);
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

/**
 * Extract the final assistant reply text from a set of messages.
 * Local copy of agent.extractTextFromResponse — inlined here to avoid a
 * memory → agent → tools → memory import cycle (agent.ts imports tools, which
 * imports memory/index; a cycle there breaks eval.ts and any direct memory
 * import at module-evaluation time).
 */
function extractReplyText(messages: Message[], skipAssistantMessages = 0): string {
  const allTextParts: string[] = [];
  let assistantIndex = 0;
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      assistantIndex++;
      if (assistantIndex <= skipAssistantMessages) continue;
      const textParts = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      allTextParts.push(...textParts);
    }
  }
  if (allTextParts.length > 0) {
    return allTextParts.join("\n");
  }
  return "(no response)";
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

// ═════════════════════════════════════════════════════════════════════════
// Trace capture (plan delta): per-tool-call TraceEntry rows persisted to the
// Cognee session cache so improve()'s agent-context extraction can produce
// gated agent-profile lessons (distillation becomes live). Pure helpers — no
// I/O — mirror the backfill logic in cognee/scripts/backfill_sessions.py
// (build_trace_steps). Keep both in lock-step.
// ═════════════════════════════════════════════════════════════════════════

const TRACE_PARAMS_MAX = 1000;         // cap on stringified method_params
const TRACE_RETURN_MAX = 2000;         // cap on stringified method_return_value
const TRACE_SECRETS_TOOL = "vaultwarden";
const TRACE_SECRETS_REDACTED = "[redacted — secrets tool]";

/**
 * Stringify a tool_result content payload for persistence: string → as-is;
 * block array → joined text-block text, else JSON.stringify of the remaining
 * (non-text) blocks. Returns "" when there is nothing meaningful (empty array
 * or empty string) so callers can skip entries with no content at all.
 */
function stringifyToolContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text);
    if (textParts.length > 0) return textParts.join("\n");
    // No text blocks — JSON-stringify any remaining (non-text) blocks.
    const nonText = content.filter((b) => b.type !== "text");
    if (nonText.length === 0) return ""; // truly empty — no content at all
    return JSON.stringify(content);
  }
  return "";
}

/**
 * Bound method_params to a dict. Cognee's TraceEntry REQUIRES a dict (a
 * stringified JSON string is rejected by pydantic with a 422 dict_type error —
 * verified against installed Cognee 1.4.0). Under the cap the raw input object
 * is sent as-is; oversized inputs are replaced with a marker dict carrying a
 * truncated stringified preview (same marker pattern as the vaultwarden
 * redaction {"redacted":true}).
 */
function buildMethodParams(input: Record<string, unknown>): Record<string, unknown> {
  const raw = JSON.stringify(input ?? {});
  if (raw.length <= TRACE_PARAMS_MAX) return { ...input };
  return { truncated: true, preview: raw.slice(0, TRACE_PARAMS_MAX) };
}

/**
 * Collect agent trace steps from a turn's messages. Pairs each assistant
 * tool_use block with its tool_result (found in user-role messages by
 * tool_use_id) and emits one CogneeTraceEntry per call.
 *
 * - status = result.is_error ? "error" : "success"
 * - method_params = bounded dict of block.input (see buildMethodParams)
 * - method_return_value = stringified result.content, truncated to 2000 chars
 * - error_message = same stringified content when is_error, else ""
 * - vaultwarden (secrets) tool is redacted
 * - orphaned tool_use blocks (no matching result) and entries with no content
 *   are skipped
 */
export function collectTraceSteps(messages: Message[]): CogneeTraceEntry[] {
  // tool_use_id → tool_result, from ALL user-role messages.
  const results = new Map<string, ToolResultBlock>();
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        results.set(block.tool_use_id, block as ToolResultBlock);
      }
    }
  }

  const steps: CogneeTraceEntry[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const toolUse = block as ToolUseBlock;
      const result = results.get(toolUse.id);
      if (!result) continue; // orphaned — skip

      const isError = result.is_error === true;
      const originFunction = toolUse.name;
      if (!originFunction) continue;

      let step: CogneeTraceEntry;
      if (originFunction === TRACE_SECRETS_TOOL) {
        step = {
          type: "trace",
          origin_function: originFunction,
          status: isError ? "error" : "success",
          method_params: { redacted: true },
          method_return_value: TRACE_SECRETS_REDACTED,
          error_message: isError ? TRACE_SECRETS_REDACTED : "",
          generate_feedback_with_llm: false,
        };
      } else {
        const returnValue = stringifyToolContent(result.content);
        const truncatedReturn =
          returnValue.length > TRACE_RETURN_MAX ? returnValue.slice(0, TRACE_RETURN_MAX) : returnValue;
        step = {
          type: "trace",
          origin_function: originFunction,
          status: isError ? "error" : "success",
          method_params: buildMethodParams(toolUse.input),
          method_return_value: truncatedReturn,
          error_message: isError ? truncatedReturn : "",
          generate_feedback_with_llm: false,
        };
      }

      // Skip entries with no content at all.
      if (!step.method_return_value || !step.method_return_value.trim()) continue;
      steps.push(step);
    }
  }
  return steps;
}
