/**
 * OpenRouter API client.
 * Translates Anthropic-format messages to OpenAI format and back.
 */

import { config } from "../config.js";
import type {
  Message,
  ClaudeResponse,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  StreamEvent,
  ToolDefinition,
  ClaudeUsage,
} from "../types.js";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const API_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// OpenRouter model context windows (hardcoded lookup table)
const CONTEXT_WINDOWS: Record<string, number> = {
  "z-ai/glm-5.2": 1_048_576,
};

/**
 * Strip the Claude Code identity string from system prompt.
 * This string is required for OAuth on Anthropic but meaningless for OpenRouter.
 */
function stripClaudeIdentity(systemPrompt: Array<{ type: "text"; text: string }>): Array<{
  type: "text";
  text: string;
}> {
  return systemPrompt
    .map((block) => ({
      ...block,
      text: block.text
        .replace(/You are Claude Code, Anthropic's official CLI for Claude\.\s*/g, "")
        .trim(),
    }))
    .filter((block) => block.text.length > 0);
}

/**
 * Strip cache_control markers (OpenRouter has no equivalent).
 */
function stripCacheControl(content: string): string {
  // Simple regex to remove cache_control markers from JSON
  // This is a crude approach but works for the prepareSystemPromptForClaude output
  return content.replace(/"cache_control":\s*{[^}]*}/g, "");
}

/**
 * Remove thinking blocks (OpenRouter models don't expose thinking).
 */
function stripThinkingBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
}

/**
 * Translate Anthropic tool definitions to OpenAI function format.
 */
function translateToolDefinitions(
  tools: ToolDefinition[]
): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/**
 * Translate Anthropic message format to OpenAI format.
 * Handles: system prompt, message content blocks, tool_use/tool_result conversions.
 */
function translateMessages(
  messages: Message[],
  systemPrompt: Array<{ type: "text"; text: string }>
): {
  messages: Array<{ role: string; content: unknown }>;
  system: string;
} {
  // Clean system prompt
  const cleanedSystemPrompt = stripClaudeIdentity(systemPrompt);
  const systemText = cleanedSystemPrompt.map((b) => b.text).join("\n\n");

  const translated: Array<{ role: string; content: unknown }> = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: msg.content }];

      // Separate text/image content from tool_use blocks
      const regularContent: Array<{ type: string; text?: string; image_url?: unknown }> = [];
      const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];

      for (const block of content) {
        if (block.type === "text") {
          regularContent.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          // Convert Anthropic image format to OpenAI format
          const imageBlock = block as any;
          if (
            imageBlock.source?.type === "base64" &&
            imageBlock.source?.media_type &&
            imageBlock.source?.data
          ) {
            regularContent.push({
              type: "image_url",
              image_url: {
                url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`,
              },
            });
          }
        } else if (block.type === "tool_use") {
          const toolBlock = block as ToolUseBlock;
          toolCalls.push({
            id: toolBlock.id,
            type: "function",
            function: {
              name: toolBlock.name,
              arguments: JSON.stringify(toolBlock.input),
            },
          });
        }
        // Skip thinking blocks
      }

      // Build OpenAI message
      const openaiMsg: { role: string; content?: unknown; tool_calls?: unknown } = {
        role: "assistant",
      };

      if (regularContent.length > 0) {
        openaiMsg.content = regularContent.length === 1 ? regularContent[0].text : regularContent;
      } else {
        openaiMsg.content = "";
      }

      if (toolCalls.length > 0) {
        openaiMsg.tool_calls = toolCalls;
      }

      translated.push(openaiMsg as { role: string; content: unknown });
    } else if (msg.role === "user") {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text" as const, text: msg.content }];

      // Check if this message contains tool_results
      const hasToolResults = content.some((b) => b.type === "tool_result");

      if (hasToolResults) {
        // Tool results message: create multiple tool messages
        for (const block of content) {
          if (block.type === "tool_result") {
            const toolResultBlock = block as ToolResultBlock;
            const toolContent =
              typeof toolResultBlock.content === "string"
                ? toolResultBlock.content
                : JSON.stringify(toolResultBlock.content);

            translated.push({
              role: "tool",
              content: toolContent,
              // Cast to any to allow OpenAI-specific tool_call_id field
              tool_call_id: toolResultBlock.tool_use_id,
            } as any);
          }
        }
      } else {
        // Regular user message
        const regularContent: Array<{ type: string; text?: string; image_url?: unknown }> = [];

        for (const block of content) {
          if (block.type === "text") {
            regularContent.push({ type: "text", text: block.text });
          } else if (block.type === "image") {
            const imageBlock = block as any;
            if (
              imageBlock.source?.type === "base64" &&
              imageBlock.source?.media_type &&
              imageBlock.source?.data
            ) {
              regularContent.push({
                type: "image_url",
                image_url: {
                  url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`,
                },
              });
            }
          }
        }

        translated.push({
          role: "user",
          content: regularContent.length === 1 && regularContent[0].type === "text" 
            ? regularContent[0].text 
            : regularContent,
        });
      }
    }
  }

  return { messages: translated, system: systemText };
}

/**
 * Translate OpenAI tool_choice format to match Anthropic's.
 */
function translateToolChoice(
  toolChoice?: { type: "tool"; name: string } | { type: "auto" }
): { type: "function" | "auto"; function?: { name: string } } | undefined {
  if (!toolChoice) return undefined;

  if (toolChoice.type === "tool") {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return { type: "auto" };
}

/**
 * Translate OpenAI response back to Anthropic format.
 */
function translateResponse(openaiResponse: {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}): ClaudeResponse {
  const choice = openaiResponse.choices[0];
  const message = choice.message;

  const content: ContentBlock[] = [];

  // Add text content if present
  if (message.content && message.content.trim()) {
    content.push({
      type: "text",
      text: message.content,
    });
  }

  // Add tool_use blocks from tool_calls
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.warn(`[openrouter] Failed to parse tool arguments for ${toolCall.id}:`, e);
      }

      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input: parsedInput,
      });
    }
  }

  // Determine stop_reason
  const stopReason =
    message.tool_calls && message.tool_calls.length > 0
      ? ("tool_use" as const)
      : ("end_turn" as const);

  return {
    id: "msg-openrouter",
    type: "message",
    role: "assistant",
    content,
    model: "openrouter",
    stop_reason: stopReason,
    usage: {
      input_tokens: openaiResponse.usage.prompt_tokens,
      output_tokens: openaiResponse.usage.completion_tokens,
    },
  };
}

/**
 * Make a non-streaming call to OpenRouter API.
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

  // Translate to OpenAI format
  const { messages: translatedMessages, system } = translateMessages(messages, systemPrompt);
  const translatedTools = tools.length > 0 ? translateToolDefinitions(tools) : undefined;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: translatedMessages,
  };

  if (system) {
    body.system = system;
  }

  if (translatedTools) {
    body.tools = translatedTools;
  }

  if (toolChoice) {
    body.tool_choice = translateToolChoice(toolChoice);
  }

  // Pin z-ai/glm-5.2 to z.ai servers with fp8 quantization
  if (model === "z-ai/glm-5.2") {
    body.provider = { order: ["z-ai"], quantizations: ["fp8"] };
  }

  // Compose caller signal with timeout
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "patronum-cli/1.0",
      },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
    }

    const openaiResponse = (await response.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return translateResponse(openaiResponse);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `OpenRouter API call timed out after ${API_TIMEOUT_MS / 1000 / 60} minutes — connection stalled`
      );
    }
    throw error;
  }
}

/**
 * Parse OpenAI SSE stream chunks.
 */
function parseOpenAISSEChunk(data: string): {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{ id?: string; index?: number; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
} | null {
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Make a streaming call to OpenRouter API.
 * Returns an async generator of Anthropic-format StreamEvents.
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
  const maxTokens = options?.maxTokens || 48000;

  // Translate to OpenAI format
  const { messages: translatedMessages, system } = translateMessages(messages, systemPrompt);
  const translatedTools = tools.length > 0 ? translateToolDefinitions(tools) : undefined;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: translatedMessages,
  };

  if (system) {
    body.system = system;
  }

  if (translatedTools) {
    body.tools = translatedTools;
  }

  if (toolChoice) {
    body.tool_choice = translateToolChoice(toolChoice);
  }

  // Pin z-ai/glm-5.2 to z.ai servers with fp8 quantization
  if (model === "z-ai/glm-5.2") {
    body.provider = { order: ["z-ai"], quantizations: ["fp8"] };
  }

  // Compose caller signal with timeout
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "patronum-cli/1.0",
      },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `OpenRouter API call timed out after ${API_TIMEOUT_MS / 1000 / 60} minutes — connection stalled`
      );
    }
    throw error;
  }

  // Translate OpenAI streaming to Anthropic format
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let accumulatedText = "";
  let textBlockStarted = false;
  
  // Track tool calls by index: index → { id, name, accumulatedArgs }
  let toolCallsByIndex: Record<number, { id: string; name: string; accumulatedArgs: string }> = {};
  let accumulatedToolCalls: Array<{ id: string; name: string }> = [];
  
  let messageStartEmitted = false;

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Task cancelled");

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by newlines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6);
        const chunk = parseOpenAISSEChunk(data);

        if (!chunk || !chunk.choices || chunk.choices.length === 0) continue;

        // Extract delta from choices[0]
        const delta = chunk.choices[0].delta;
        if (!delta) continue;

        // Emit message_start on first chunk with usage info
        if (!messageStartEmitted) {
          // OpenAI doesn't send usage until the end, so we fake it here
          const messageStart: StreamEvent = {
            type: "message_start" as const,
            message: {
              id: "msg-openrouter",
              type: "message",
              role: "assistant",
              content: [],
              model: "openrouter",
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          };
          yield messageStart;
          messageStartEmitted = true;
        }

        // Handle text content
        if (delta.content) {
          accumulatedText += delta.content;

          // Emit text content block start on first text delta
          if (!textBlockStarted) {
            const blockStart: StreamEvent = {
              type: "content_block_start" as const,
              index: 0,
              content_block: { type: "text", text: "" },
            };
            yield blockStart;
            textBlockStarted = true;
          }

          // Emit text delta
          const textDelta: StreamEvent = {
            type: "content_block_delta" as const,
            index: 0,
            delta: { type: "text_delta", text: delta.content },
          };
          yield textDelta;
        }

        // Handle tool calls
        if (delta.tool_calls && delta.tool_calls.length > 0) {
          for (const toolCall of delta.tool_calls) {
            // Use index field (always present in tool_calls chunks)
            const index = toolCall.index ?? 0;

            // First chunk for this tool call index has id and name
            if (toolCall.id && toolCall.function?.name) {
              toolCallsByIndex[index] = {
                id: toolCall.id,
                name: toolCall.function.name,
                accumulatedArgs: "",
              };

              // Emit tool_use content block start
              const blockStart: StreamEvent = {
                type: "content_block_start" as const,
                index: (textBlockStarted ? 1 : 0) + accumulatedToolCalls.length,
                content_block: {
                  type: "tool_use",
                  id: toolCall.id,
                  name: toolCall.function.name,
                  input: {},
                },
              };
              yield blockStart;

              // Track this tool call
              accumulatedToolCalls.push({ id: toolCall.id, name: toolCall.function.name });
            }

            // Accumulate arguments (subsequent chunks only have index and partial arguments)
            if (toolCall.function?.arguments) {
              const toolCallData = toolCallsByIndex[index];
              if (toolCallData) {
                toolCallData.accumulatedArgs += toolCall.function.arguments;

                // Emit input_json_delta
                const argDelta: StreamEvent = {
                  type: "content_block_delta" as const,
                  index: (textBlockStarted ? 1 : 0) + accumulatedToolCalls.findIndex(
                    (tc) => tc.id === toolCallData.id
                  ),
                  delta: {
                    type: "input_json_delta",
                    partial_json: toolCall.function.arguments,
                  },
                };
                yield argDelta;
              }
            }
          }
        }
      }
    }

    // Emit content_block_stop for text block if we had any
    if (textBlockStarted) {
      const blockStop: StreamEvent = {
        type: "content_block_stop" as const,
        index: 0,
      };
      yield blockStop;
    }

    // Emit content_block_stop for each tool call
    for (let i = 0; i < accumulatedToolCalls.length; i++) {
      const blockStop: StreamEvent = {
        type: "content_block_stop" as const,
        index: (textBlockStarted ? 1 : 0) + i,
      };
      yield blockStop;
    }

    // Emit message_delta with stop_reason
    const hasToolCalls = accumulatedToolCalls.length > 0;
    const messageDelta: StreamEvent = {
      type: "message_delta" as const,
      delta: {
        stop_reason: hasToolCalls ? ("tool_use" as const) : ("end_turn" as const),
      },
      usage: { output_tokens: 0 },
    };
    yield messageDelta;

    // Emit message_stop
    const messageStop: StreamEvent = {
      type: "message_stop" as const,
    };
    yield messageStop;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Get context window for a model.
 */
function getContextWindow(model: string): Promise<number> {
  const contextWindow = CONTEXT_WINDOWS[model];
  if (contextWindow) {
    return Promise.resolve(contextWindow);
  }

  // Default fallback for unknown OpenRouter models
  console.warn(`[openrouter] Unknown model ${model}, using fallback context window of 200k`);
  return Promise.resolve(200_000);
}

export const openrouterClient = {
  call,
  stream,
  getContextWindow,
};
