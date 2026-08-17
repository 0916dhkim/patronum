/**
 * Cognee HTTP client for Patronum.
 * Routes memory operations to Cognee REST API when backend=cognee.
 * Uses fetch() for all API calls — no additional dependencies.
 *
 * Endpoints validated against Cognee 1.4.0 REST API.
 * See Phase 2 PoC results for full contract details.
 */

import { config } from "../config.js";

const COGNEE_BASE_URL = "http://127.0.0.1:8001";
const DATASET_NAME = "patronum_memory";

// Timeouts (ms)
// RECALL: High-level graph completion uses LLM (gpt-5-mini via OpenRouter) to
// synthesize answers from the knowledge graph. Observed latencies range from
// ~6s (GRAPH_COMPLETION_COT warm) to ~18s+ (GRAPH_COMPLETION cold/routed).
// We use 30s to cover LLM inference + graph traversal while still bounding
// the total wait and preventing indefinite blocking.
// CHUNKS recall (legacy) takes ~300-500ms by comparison.
const TIMEOUT_RECALL = 30_000;
const TIMEOUT_HEALTH = 2_000;
// ── Memory redesign (harness-owned session capture + bounded auto-recall) ──
const TIMEOUT_REMEMBER_ENTRY = 15_000;  // session-cache QA write is fast
const TIMEOUT_REMEMBER_TRACE = 60_000;  // trace (agent trace step) write is heavier — generous, still bounded

export interface CogneeRecallResult {
  kind: string;
  text: string;
  score: number | null;
  dataset_id: string;
  dataset_name: string;
  metadata: {
    data_id?: string;
    chunk_id?: string;
    chunk_index?: number;
    document_name?: string;
    [key: string]: unknown;
  };
  raw?: Record<string, unknown>;
}

/**
 * Get the Cognee API key from config (read from patronum.toml or Vaultwarden).
 */
function getApiKey(): string | undefined {
  const cfg = config as any;
  // Check for cogneeApiKey from config (patronum.toml [memory] section)
  if (cfg.cogneeApiKey && typeof cfg.cogneeApiKey === "string" && cfg.cogneeApiKey.length > 0) {
    return cfg.cogneeApiKey;
  }
  // Fallback: check environment variable
  if (typeof process !== "undefined" && process.env?.COGNEE_API_KEY) {
    return process.env.COGNEE_API_KEY;
  }
  return undefined;
}

function authHeaders(): Record<string, string> {
  const apiKey = getApiKey();
  if (apiKey) {
    return { "X-Api-Key": apiKey };
  }
  return {};
}

/**
 * Health check — returns true if Cognee is reachable.
 */
export async function health(): Promise<boolean> {
  try {
    const r = await fetch(`${COGNEE_BASE_URL}/health`, {
      signal: AbortSignal.timeout(TIMEOUT_HEALTH),
    });
    if (r.status === 200) {
      const body = await r.json() as { status?: string; health?: string };
      return body.status === "ready" || body.health === "healthy";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Recall — high-level semantic search against Cognee.
 * Uses minimal request body { query, datasets } — Cognee selects the
 * optimal retrieval strategy (graph, vector, hybrid) automatically.
 *
 * Returns raw structured results from Cognee REST API, preserving
 * kind, metadata, data_id, and all provenance fields.
 */
export async function recall(
  query: string
): Promise<CogneeRecallResult[]> {
  const r = await fetch(`${COGNEE_BASE_URL}/api/v1/recall`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      query,
      datasets: [DATASET_NAME],
    }),
    signal: AbortSignal.timeout(TIMEOUT_RECALL),
  });

  if (!r.ok) {
    const text = await r.text();
    // "Recall prerequisites not met" means no data ingested yet — empty result
    if (text.includes("Recall prerequisites not met")) {
      return [];
    }
    throw new Error(`Cognee recall error ${r.status}: ${text}`);
  }

  const data = (await r.json()) as CogneeRecallResult[];
  return data;
}

/**
 * Format recall results into a context string for the LLM.
 * Preserves kind/provenance/data_id when present in Cognee response.
 */
export function formatRecallResults(results: CogneeRecallResult[]): string {
  if (results.length === 0) return "";

  return results
    .map((r, i) => {
      const parts: string[] = [];

      // Kind tag — Cognee returns "chunk", "graph", "summary", etc.
      if (r.kind) {
        parts.push(`(kind: ${r.kind})`);
      }

      // Data_id for provenance lookup
      if (r.metadata?.data_id) {
        parts.push(`data_id: ${r.metadata.data_id}`);
      }

      // Document/chunk info if available
      if (r.metadata?.document_name) {
        parts.push(`document: ${r.metadata.document_name}`);
      }
      if (r.metadata?.chunk_index !== undefined) {
        parts.push(`chunk_index: ${r.metadata.chunk_index}`);
      }

      // Score if present
      if (r.score !== null && r.score !== undefined) {
        parts.push(`score: ${r.score.toFixed(4)}`);
      }

      const header = parts.length > 0 ? `[${i + 1}] ${parts.join(" | ")}\n` : `[${i + 1}] `;
      const text = r.text || r.metadata?.text || "";
      return `${header}${text}`;
    })
    .join("\n\n---\n\n");
}

interface RememberQaResult {
  status?: string;
  entry_type?: string;
  entry_id?: string;
  [key: string]: unknown;
}

/**
 * One agent trace step persisted to the Cognee session cache (typed TraceEntry).
 * Harness-owned per-tool-call rows that improve()'s agent-context extraction
 * consumes to produce gated agent-profile lessons (distillation becomes live).
 *
 * CONTRACT (verified against installed Cognee 1.4.0): `method_params` MUST be a
 * dict — pydantic rejects a stringified JSON string with a 422 dict_type error.
 * `method_return_value` may be any JSON value (string is fine; sanitized +
 * truncated server-side); `error_message` is a string. Callers build
 * `method_params` as a dict; oversized params are bounded as
 * {"truncated":true,"preview":<stringified slice>}.
 */
export interface CogneeTraceEntry {
  type: "trace";
  origin_function: string;
  status: "success" | "error";
  method_params?: Record<string, unknown>;
  method_return_value?: string;
  error_message?: string;
  generate_feedback_with_llm: false;
}

/**
 * Store a single QA exchange in the Cognee session cache (typed QAEntry).
 * Session-cache only — no graph writes, no self-improvement (routes to
 * sm.add_qa()). Requires session_id (Cognee returns 400 otherwise).
 *
 * Callers treat failures as non-fatal (fail-open).
 */
export async function rememberQaEntry(
  question: string,
  answer: string,
  sessionId: string,
  context?: string
): Promise<RememberQaResult> {
  const r = await fetch(`${COGNEE_BASE_URL}/api/v1/remember/entry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      entry: {
        type: "qa",
        question,
        answer,
        ...(context ? { context } : {}),
      },
      dataset_name: DATASET_NAME,
      session_id: sessionId,
    }),
    signal: AbortSignal.timeout(TIMEOUT_REMEMBER_ENTRY),
  });

  if (!r.ok) {
    // Log status only — never echo the response body (FastAPI validation
    // errors echo submitted input, which could carry tool content).
    throw new Error(`Cognee remember/entry error ${r.status}`);
  }
  return (await r.json()) as RememberQaResult;
}

/**
 * Store a single agent trace step in the Cognee session cache (typed TraceEntry).
 * Session-cache only — routes to sm.add_agent_trace_step(). These rows feed
 * improve()'s agent-context extraction (trace-derived agent lessons), which is
 * what makes distillation live under this redesign (see plan delta).
 *
 * Payload mirrors rememberQaEntry: POST /api/v1/remember/entry with {entry,
 * dataset_name, session_id}, X-Api-Key auth, bounded by TIMEOUT_REMEMBER_TRACE.
 * Fail-open: throws on !ok (status + body) so callers can log, never crashes
 * the caller.
 */
export async function rememberTraceEntry(
  entry: CogneeTraceEntry,
  sessionId: string
): Promise<RememberQaResult> {
  const r = await fetch(`${COGNEE_BASE_URL}/api/v1/remember/entry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      entry,
      dataset_name: DATASET_NAME,
      session_id: sessionId,
    }),
    signal: AbortSignal.timeout(TIMEOUT_REMEMBER_TRACE),
  });

  if (!r.ok) {
    // Log status only — never echo the response body (validation errors echo
    // submitted input, which could carry tool content).
    throw new Error(`Cognee remember/entry (trace) error ${r.status}`);
  }
  return (await r.json()) as RememberQaResult;
}
