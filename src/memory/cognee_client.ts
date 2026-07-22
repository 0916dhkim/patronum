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
const TIMEOUT_ADD = 30_000;       // cognify can take ~55s
const TIMEOUT_COGNIFY = 5_000;
const TIMEOUT_HEALTH = 2_000;
const TIMEOUT_REMEMBER = 60_000;  // blocking remember can take 20-60s

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

interface CogneeAddResult {
  status: string;
  pipeline_run_id?: string;
  dataset_id?: string;
  dataset_name?: string;
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

/**
 * Remember — combined add + cognify in one call (preferred for auto-store).
 * Uses /api/v1/remember. Blocking mode waits for cognify to complete.
 * Background mode (run_in_background=true) returns immediately.
 *
 * Validated in P5: blocking ~55s per batch, background returns instantly.
 */
export async function remember(
  text: string,
  background: boolean = true
): Promise<{ status: string; dataset_name?: string; dataset_id?: string }> {
  const blob = new Blob([text], { type: "text/plain" });
  const formData = new FormData();
  formData.append("datasetName", DATASET_NAME);
  formData.append("run_in_background", String(background));
  formData.append("data", blob, "exchange.txt");

  const r = await fetch(`${COGNEE_BASE_URL}/api/v1/remember`, {
    method: "POST",
    body: formData,
    headers: authHeaders(),
    signal: AbortSignal.timeout(background ? TIMEOUT_ADD : TIMEOUT_REMEMBER),
  });

  if (!r.ok) {
    throw new Error(`Cognee remember error ${r.status}: ${await r.text()}`);
  }

  return (await r.json()) as { status: string; dataset_name?: string; dataset_id?: string };
}

/**
 * Add — ingest a text chunk into Cognee (legacy two-step path).
 * Uses multipart file upload via /api/v1/add.
 * Note: does NOT support external_metadata via REST API (see P1).
 * For metadata support, use addWithMetadata() or the Python wrapper.
 */
export async function add(
  text: string
): Promise<CogneeAddResult> {
  const blob = new Blob([text], { type: "text/plain" });
  const formData = new FormData();
  formData.append("datasetName", DATASET_NAME);
  formData.append("data", blob, "exchange.txt");

  const r = await fetch(`${COGNEE_BASE_URL}/api/v1/add`, {
    method: "POST",
    body: formData,
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_ADD),
  });

  if (!r.ok) {
    throw new Error(`Cognee add error ${r.status}: ${await r.text()}`);
  }

  return (await r.json()) as CogneeAddResult;
}

/**
 * Cognify — trigger graph building for a dataset (legacy two-step path).
 * Fire-and-forget when run_in_background=true.
 * Scheduled periodically rather than per-turn (P5 finding).
 */
export async function cognify(
  datasetName: string = DATASET_NAME,
  background: boolean = true
): Promise<{ status: string; pipeline_run_id?: string }> {
  const r = await fetch(`${COGNEE_BASE_URL}/api/v1/cognify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      datasets: [datasetName],
      run_in_background: background,
    }),
    signal: AbortSignal.timeout(TIMEOUT_COGNIFY),
  });

  if (!r.ok) {
    throw new Error(`Cognee cognify error ${r.status}: ${await r.text()}`);
  }

  return (await r.json()) as { status: string; pipeline_run_id?: string };
}

/**
 * Forget — remove a dataset from Cognee (for rollback).
 */
export async function forget(datasetName?: string): Promise<void> {
  const r = await fetch(`${COGNEE_BASE_URL}/api/v1/forget`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      dataset: datasetName ?? DATASET_NAME,
    }),
    signal: AbortSignal.timeout(TIMEOUT_ADD),
  });

  if (!r.ok) {
    throw new Error(`Cognee forget error ${r.status}: ${await r.text()}`);
  }
}

/**
 * Add with external metadata — ASYNC (non-blocking) version.
 * Uses Python wrapper script for metadata support (P1 workaround).
 * Spawns child process asynchronously — does NOT block the Node event loop.
 * Required for memory_fetch_context metadata recovery.
 *
 * SECURITY: Cognee runtime credentials (pgvector password, embedding/LLM API keys)
 * are fetched from Vaultwarden at runtime — never written to disk or logged.
 * Same runtime-only model as cognee-start.sh / vaultwarden_secrets.cjs.
 */
export async function addWithMetadata(
  text: string,
  metadata: {
    source: string;
    chat_id: string;
    timestamp: string;
    turn_number?: number;
  }
): Promise<CogneeAddResult> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const tmpDir = os.tmpdir();
  const textFile = path.join(tmpDir, `cognee_add_${Date.now()}.txt`);
  const metaFile = path.join(tmpDir, `cognee_add_${Date.now()}.json`);

  try {
    await fs.promises.writeFile(textFile, text, "utf-8");
    await fs.promises.writeFile(metaFile, JSON.stringify(metadata), "utf-8");

    const venvPath = "/var/lib/patronum/cognee/.venv312/bin/python";
    const wrapperScript = "/var/lib/patronum/cognee/scripts/add_with_metadata.py";

    // ───────────────────────────────────────────────────────────
    // Runtime secret injection: fetch Cognee credentials from Vaultwarden
    // to provide pgvector password and embedding/LLM keys for the Python
    // subprocess. Same mechanism as cognee-start.sh — no disk persistence.
    // ───────────────────────────────────────────────────────────
    const secretsEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) secretsEnv[k] = v;
    }
    try {
      const vaultHelper = "/var/lib/patronum/source/dist/tools/vaultwarden_secrets.cjs";
      const { stdout: secretsOut } = await execFileAsync(
        "/usr/bin/node", [vaultHelper],
        { timeout: 10_000, env: { ...process.env } }
      );
      for (const line of secretsOut.trim().split("\n")) {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          const k = line.substring(0, eqIdx);
          const v = line.substring(eqIdx + 1);
          if (k && v) secretsEnv[k] = v;
        }
      }
    } catch {
      // If Vaultwarden fetch fails, fall through with existing env
      // The Python wrapper will likely fail with missing pgvector credentials,
      // and Patronum will fall back to REST API add() without metadata.
    }

    const { stdout } = await execFileAsync(venvPath, [wrapperScript, textFile, metaFile], {
      timeout: 30_000,
      env: secretsEnv,
    });

    return JSON.parse(stdout) as CogneeAddResult;
  } finally {
    try { await fs.promises.unlink(textFile); } catch { /* ignore */ }
    try { await fs.promises.unlink(metaFile); } catch { /* ignore */ }
  }
}