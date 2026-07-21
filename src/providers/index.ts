/**
 * Provider abstraction layer for LLM API clients.
 * Supports both Anthropic and OpenRouter APIs with automatic provider detection.
 */

import { anthropicClient } from "./anthropic.js";
import { openrouterClient } from "./openrouter.js";
import { config } from "../config.js";
import type { Message, ClaudeResponse, StreamEvent, ToolDefinition } from "../types.js";

/**
 * Detect provider from model string.
 * OpenRouter models contain a "/" (e.g. "z-ai/glm-5.2")
 * Anthropic models do not.
 */
function getProvider(model: string): "anthropic" | "openrouter" {
  if (model.includes("/")) {
    return "openrouter";
  }
  return "anthropic";
}

/**
 * Make a non-streaming API call to the selected provider.
 * Returns response in Anthropic format.
 */
export async function callLLM(
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
  const provider = getProvider(model);

  if (provider === "openrouter") {
    return openrouterClient.call(messages, model, systemPrompt, tools, options, signal, toolChoice);
  } else {
    return anthropicClient.call(messages, model, systemPrompt, tools, options, signal, toolChoice);
  }
}

/**
 * Make a streaming API call to the selected provider.
 * Returns an async generator of Anthropic-format StreamEvents.
 */
export async function callLLMStreaming(
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
): Promise<AsyncGenerator<StreamEvent>> {
  const provider = getProvider(model);

  if (provider === "openrouter") {
    return openrouterClient.stream(messages, model, systemPrompt, tools, options, signal, toolChoice);
  } else {
    return anthropicClient.stream(messages, model, systemPrompt, tools, options, signal, toolChoice);
  }
}

/**
 * Get the context window size for a model.
 * For Anthropic models, queries the Anthropic models API.
 * For OpenRouter models, uses a hardcoded lookup table.
 */
export async function getContextWindow(model: string): Promise<number> {
  const provider = getProvider(model);

  if (provider === "openrouter") {
    return openrouterClient.getContextWindow(model);
  } else {
    return anthropicClient.getContextWindow(model);
  }
}
