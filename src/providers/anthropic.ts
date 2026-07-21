/**
 * Anthropic API client.
 * Implements the provider interface for native Anthropic API calls.
 */

import { config } from "../config.js";
import { prepareMessagesForClaude, prepareSystemPromptForClaude, logUsage, getTotalInputTokens } from "../prompt-cache.js";
import type { Message, ClaudeResponse, StreamEvent, ToolDefinition } from "../types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_API_URL = "https://api.anthropic.com/v1/models";
const API_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const FALLBACK_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-20250514": 200_000,
};

// Cache: model id → context_window size
const contextWindowCache = new Map<string, number>();

/**
 * Fetch the context window size for a model from the Anthropic models API.
 * Caches results in memory.
 */
export async function fetchContextWindow(model: string): Promise<number> {
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
      const data = (await response.json()) as { context_window?: number; max_input_tokens?: number };
      const contextWindow = data.context_window ?? data.max_input_tokens;
      if (contextWindow) {
        contextWindowCache.set(model, contextWindow);
        console.log(`[anthropic] Cached context window for ${model}: ${contextWindow}`);
        return contextWindow;
      }
    } else {
      console.warn(`[anthropic] Models API returned ${response.status} for ${model}, using fallback`);
    }
  } catch (err) {
    console.warn(`[anthropic] Failed to fetch context window for ${model}:`, err);
  }

  // Fallback
  const fallback = FALLBACK_CONTEXT_WINDOWS[model] ?? 200_000;
  contextWindowCache.set(model, fallback);
  console.log(`[anthropic] Using fallback context window for ${model}: ${fallback}`);
  return fallback;
}

/**
 * Make a non-streaming call to Anthropic API.
 */
async function call(
  messages: Message[],
  model: string,
  systemPrompt: Array<{ type: "text"; text: string }>,
  tools: ToolDefinition[],
  options?: {
    thinking?: boolean;
    maxTokens?: number;
    completedPrefixLength?: number;
  },
  signal?: AbortSignal,
  toolChoice?: { type: "tool"; name: string } | { type: "auto" }
): Promise<ClaudeResponse> {
  const maxTokens = options?.maxTokens || 48000;
  const completedPrefixLength = options?.completedPrefixLength || 0;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: prepareSystemPromptForClaude(systemPrompt),
    tools: tools.length > 0 ? tools : undefined,
    messages: prepareMessagesForClaude(messages, { completedPrefixLength }),
  };

  if (options?.thinking) {
    body.thinking = { type: "enabled", budget_tokens: 32000 };
  }

  if (toolChoice) {
    body.tool_choice = toolChoice;
  }

  // Remove undefined values
  Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);

  // Compose caller signal with 30-minute timeout
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.claudeToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": "claude-cli/2.1.85",
        "x-app": "cli",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errorBody}`);
    }

    return (await response.json()) as ClaudeResponse;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `Claude API call timed out after ${API_TIMEOUT_MS / 1000 / 60} minutes — connection stalled`
      );
    }
    throw error;
  }
}

/**
 * Make a streaming call to Anthropic API.
 * Returns the raw Response object for streaming.
 */
async function streamRaw(
  messages: Message[],
  model: string,
  systemPrompt: Array<{ type: "text"; text: string }>,
  tools: ToolDefinition[],
  options?: {
    thinking?: boolean;
    maxTokens?: number;
    completedPrefixLength?: number;
  },
  signal?: AbortSignal,
  toolChoice?: { type: "tool"; name: string } | { type: "auto" }
): Promise<Response> {
  const maxTokens = options?.maxTokens || 48000;
  const completedPrefixLength = options?.completedPrefixLength || 0;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: prepareSystemPromptForClaude(systemPrompt),
    tools: tools.length > 0 ? tools : undefined,
    messages: prepareMessagesForClaude(messages, { completedPrefixLength }),
    stream: true,
  };

  if (options?.thinking) {
    body.thinking = { type: "enabled", budget_tokens: 32000 };
  }

  if (toolChoice) {
    body.tool_choice = toolChoice;
  }

  // Remove undefined values
  Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);

  // Compose caller signal with 30-minute timeout
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.claudeToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": "claude-cli/2.1.85",
        "x-app": "cli",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errorBody}`);
    }

    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `Claude API call timed out after ${API_TIMEOUT_MS / 1000 / 60} minutes — connection stalled`
      );
    }
    throw error;
  }
}

/**
 * Parse Anthropic SSE stream and yield StreamEvents.
 */
async function* parseSSEStream(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<StreamEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Task cancelled");

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!; // Keep the incomplete last part in the buffer

      for (const part of parts) {
        const lines = part.split("\n");
        let eventData = "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            eventData += line.slice(6);
          }
        }

        if (eventData && eventData.trim()) {
          try {
            const parsed = JSON.parse(eventData) as StreamEvent;
            yield parsed;
          } catch {
            console.warn("[anthropic] Failed to parse SSE event:", eventData.slice(0, 200));
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Make a streaming call and return an async generator of StreamEvents.
 */
async function* stream(
  messages: Message[],
  model: string,
  systemPrompt: Array<{ type: "text"; text: string }>,
  tools: ToolDefinition[],
  options?: {
    thinking?: boolean;
    maxTokens?: number;
    completedPrefixLength?: number;
  },
  signal?: AbortSignal,
  toolChoice?: { type: "tool"; name: string } | { type: "auto" }
): AsyncGenerator<StreamEvent> {
  const response = await streamRaw(messages, model, systemPrompt, tools, options, signal, toolChoice);
  yield* parseSSEStream(response, signal);
}

/**
 * Get context window for a model.
 */
async function getContextWindow(model: string): Promise<number> {
  return fetchContextWindow(model);
}

export const anthropicClient = {
  call,
  stream,
  getContextWindow,
};
