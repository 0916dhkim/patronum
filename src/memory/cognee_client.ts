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

// Timeouts (ms) — validated in PoC: recall median 289ms
const TIMEOUT_RECALL = 5_000;
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
 * Recall — semantic search against Cognee.
 * Returns raw results from Cognee REST API.
 */
export async function recall(
  query: string,
  options?: {
    topK?: number;
    searchType?: string;
    onlyContext?: boolean;
  }
): Promise<CogneeRecallResult[]> {
  const topK = options?.topK ?? 6;
  const searchType = options?.searchType ?? "CHUNKS";
  const onlyContext = options?.onlyContext ?? true;

  const r = await fetch(`${COGNEE_BASE_URL}/api/v1/recall`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      query,
      search_type: searchType,
      only_context: onlyContext,
      top_k: topK,
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
 */
export function formatRecallResults(results: CogneeRecallResult[]): string {
  if (results.length === 0) return "";

  return results
    .map((r, i) => `[${i + 1}] ${r.text}`)
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

    const { stdout } = await execFileAsync(venvPath, [wrapperScript, textFile, metaFile], {
      timeout: 30_000,
      env: { ...process.env },
    });

    return JSON.parse(stdout) as CogneeAddResult;
  } finally {
    try { await fs.promises.unlink(textFile); } catch { /* ignore */ }
    try { await fs.promises.unlink(metaFile); } catch { /* ignore */ }
  }
}