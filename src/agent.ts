import { config } from "./config.js";
import { loadContextFile } from "./context.js";
import { getProjectContext } from "./project-context.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";
import { buildSubagentsSummary } from "./agents.js";
import { buildSkillsSummary, buildSkillBodies } from "./skills.js";
import {
  prepareMessagesForClaude,
  prepareSystemPromptForClaude,
  logUsage,
  getTotalInputTokens,
} from "./prompt-cache.js";

import type {
  Message,
  ClaudeResponse,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
} from "./types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 48000; // Must be greater than thinking budget_tokens (32000) + output capacity
const API_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes hard timeout on API calls

// OAuth tokens require the Claude Code identity system prompt to access sonnet/opus models
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>
) => Promise<{ result: string; isError: boolean; terminatesLoop: boolean }>;

export interface AgentOptions {
  /** Override the model (defaults to config.claudeModel) */
  model?: string;
  /** Override workspace for loading SOUL.md/AGENTS.md */
  workspace?: string;
  /** Additional system context blocks (e.g. thread context) */
  extraContext?: string[];
  /** Optional custom tool executor (defaults to executeTool) */
  toolExecutor?: ToolExecutor;
  /** Override system prompt entirely (bypasses buildSystemPrompt) */
  systemPrompt?: Array<{ type: "text"; text: string }>;
  /** Override SOUL.md content (eval-only) */
  soulContent?: string;
  /** Override AGENTS.md content (eval-only) */
  agentsContent?: string;
  /** Enable extended thinking mode */
  thinking?: boolean;
}

export function buildSystemPrompt(options?: AgentOptions): Array<{ type: "text"; text: string }> {
  const workspace = options?.workspace || config.workspace;

  const system: Array<{ type: "text"; text: string }> = [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ];
  const soul = options?.soulContent ?? loadContextFile(workspace, "SOUL.md");
  if (soul) system.push({ type: "text", text: soul });
  const agents = options?.agentsContent ?? loadContextFile(workspace, "AGENTS.md");
  if (agents) system.push({ type: "text", text: agents });

  // Always inject project self-knowledge
  system.push({ type: "text", text: getProjectContext() });

  // Inject available subagents summary for routing decisions
  const subagentsSummary = buildSubagentsSummary();
  if (subagentsSummary) system.push({ type: "text", text: subagentsSummary });

  // Inject available skills summary
  const skillsSummary = buildSkillsSummary();
  if (skillsSummary) system.push({ type: "text", text: skillsSummary });

  // Inject full skill instruction bodies
  const skillBodies = buildSkillBodies();
  if (skillBodies) system.push({ type: "text", text: skillBodies });

  // Append any extra context (reserved for future use — currently unused)
  if (options?.extraContext) {
    for (const ctx of options.extraContext) {
      if (ctx) system.push({ type: "text", text: ctx });
    }
  }

  return system;
}

async function callClaude(
  messages: Message[],
  options?: AgentOptions,
  signal?: AbortSignal,
  completedPrefixLength = 0
): Promise<ClaudeResponse> {
  const model = options?.model || config.claudeModel;
  const systemPrompt = options?.systemPrompt || buildSystemPrompt(options);

  const body: Record<string, unknown> = {
    model,
    max_tokens: MAX_TOKENS,
    system: prepareSystemPromptForClaude(systemPrompt),
    tools: getToolDefinitions(),
    messages: prepareMessagesForClaude(messages, { completedPrefixLength }),
  };

  if (options?.thinking) {
    body.thinking = { type: "enabled", budget_tokens: 32000 };
  }

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
      const body = await response.text();
      throw new Error(`Claude API error ${response.status}: ${body}`);
    }

    return (await response.json()) as ClaudeResponse;
  } catch (error) {
    // Distinguish timeout errors from other failures
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `Claude API call timed out after ${API_TIMEOUT_MS / 1000 / 60} minutes — connection stalled`
      );
    }
    throw error;
  }
}

async function callClaudeStreaming(
  messages: Message[],
  options?: AgentOptions,
  signal?: AbortSignal,
  completedPrefixLength = 0
): Promise<Response> {
  const model = options?.model || config.claudeModel;
  const systemPrompt = options?.systemPrompt || buildSystemPrompt(options);

  const body: Record<string, unknown> = {
    model,
    max_tokens: MAX_TOKENS,
    system: prepareSystemPromptForClaude(systemPrompt),
    tools: getToolDefinitions(),
    messages: prepareMessagesForClaude(messages, { completedPrefixLength }),
    stream: true,
  };

  if (options?.thinking) {
    body.thinking = { type: "enabled", budget_tokens: 32000 };
  }

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
      const body = await response.text();
      throw new Error(`Claude API error ${response.status}: ${body}`);
    }

    return response;
  } catch (error) {
    // Distinguish timeout errors from other failures
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `Claude API call timed out after ${API_TIMEOUT_MS / 1000 / 60} minutes — connection stalled`
      );
    }
    throw error;
  }
}

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
            console.warn("[stream] Failed to parse SSE event:", eventData.slice(0, 200));
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface AgentResult {
  messages: Message[];
  inputTokens: number;
  /** True if the agent loop terminated early due to a tool requesting termination */
  earlyTermination: boolean;
}

export interface StreamingCallbacks {
  /** Called with each new text chunk as it arrives */
  onTextDelta: (delta: string, accumulatedText: string) => void;
  /** Called when tool execution starts */
  onToolStart?: (toolName: string) => void;
  /** Called when tool execution finishes */
  onToolEnd?: (toolName: string) => void;
}

// Custom error class to preserve partial messages on abort
class TaskCancelledError extends Error {
  constructor(
    message: string,
    public partialMessages: Message[] = []
  ) {
    super(message);
    this.name = "TaskCancelledError";
  }
}

export async function runAgentStreaming(
  messages: Message[],
  callbacks: StreamingCallbacks,
  options?: AgentOptions,
  signal?: AbortSignal
): Promise<AgentResult> {
  const conversation = sanitizeMessages([...messages]);
  // Track how many messages existed before this turn started — those are the stable
  // cached prefix. New messages appended during the tool loop are not yet cached.
  const initialLength = conversation.length;
  const newMessages: Message[] = [];
  let lastInputTokens = 0;
  let fullAccumulatedText = "";
  let earlyTermination = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (signal?.aborted) throw new TaskCancelledError("Task cancelled", newMessages);

      const response = await callClaudeStreaming(conversation, options, signal, initialLength);

      // Track accumulated content blocks in original order
      const contentBlocks: ContentBlock[] = [];
      const toolUseBlocks: ToolUseBlock[] = []; // also tracked separately for tool execution
      let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
      let currentBlockType: "text" | "tool_use" | "thinking" | "redacted_thinking" | null = null;
      let currentTextBlockText = "";
      let currentToolUseId = "";
      let currentToolUseName = "";
      let currentToolUseInput = "";
      let currentThinkingText = "";
      let currentThinkingSignature = "";
      let currentRedactedThinkingData = "";

      // Parse the SSE stream
      for await (const event of parseSSEStream(response, signal)) {
        if (event.type === "message_start") {
          lastInputTokens = getTotalInputTokens(event.message.usage) || lastInputTokens;
          logUsage("lin", event.message.usage);
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            currentBlockType = "text";
            currentTextBlockText = "";
          } else if (event.content_block.type === "tool_use") {
            currentBlockType = "tool_use";
            currentToolUseId = event.content_block.id;
            currentToolUseName = event.content_block.name;
            currentToolUseInput = ""; // May remain empty if tool has no params — handled at block_stop
          } else if (event.content_block.type === "thinking") {
            currentBlockType = "thinking";
            currentThinkingText = "";
            currentThinkingSignature = "";
          } else if (event.content_block.type === "redacted_thinking") {
            currentBlockType = "redacted_thinking";
            currentRedactedThinkingData = event.content_block.data;
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            const delta = event.delta.text;
            currentTextBlockText += delta;
            fullAccumulatedText += delta;
            callbacks.onTextDelta(delta, fullAccumulatedText);
          } else if (event.delta.type === "input_json_delta") {
            currentToolUseInput += event.delta.partial_json;
          } else if (event.delta.type === "thinking_delta") {
            currentThinkingText += event.delta.thinking;
          } else if (event.delta.type === "signature_delta") {
            currentThinkingSignature += event.delta.signature;
          } else if (event.delta.type === "redacted_thinking") {
            currentRedactedThinkingData += event.delta.data;
          }
        } else if (event.type === "content_block_stop") {
          // Finalize the content block based on tracked type
          if (currentBlockType === "text") {
            const block: TextBlock = { type: "text", text: currentTextBlockText };
            contentBlocks.push(block);
            currentTextBlockText = "";
          } else if (currentBlockType === "tool_use") {
            try {
              // If no input_json_delta events were received (tool with no params),
              // default to empty object to avoid JSON.parse("") throwing
              const input = JSON.parse(currentToolUseInput || "{}") as Record<string, unknown>;
              const block: ToolUseBlock = {
                type: "tool_use",
                id: currentToolUseId,
                name: currentToolUseName,
                input,
              };
              contentBlocks.push(block);
              toolUseBlocks.push(block);
            } catch (e) {
              console.warn(`[stream] Failed to parse tool input for ${currentToolUseId}:`, e);
            }
            currentToolUseId = "";
            currentToolUseName = "";
            currentToolUseInput = "";
          } else if (currentBlockType === "thinking") {
            const block: ThinkingBlock = {
              type: "thinking",
              thinking: currentThinkingText,
              signature: currentThinkingSignature,
            };
            contentBlocks.push(block);
            currentThinkingText = "";
            currentThinkingSignature = "";
          } else if (currentBlockType === "redacted_thinking") {
            const block: RedactedThinkingBlock = {
              type: "redacted_thinking",
              data: currentRedactedThinkingData,
            };
            contentBlocks.push(block);
            currentRedactedThinkingData = "";
          }
          currentBlockType = null;
        } else if (event.type === "message_delta") {
          stopReason = event.delta.stop_reason;
        }
      }

      // Build the assistant message preserving original block order
      const content: ContentBlock[] = contentBlocks;
      const assistantMessage: Message = {
        role: "assistant",
        content,
      };
      conversation.push(assistantMessage);
      newMessages.push(assistantMessage);

      if (stopReason !== "tool_use") {
        break;
      }

      // Execute tool calls
      if (signal?.aborted) throw new TaskCancelledError("Task cancelled", newMessages);

      if (toolUseBlocks.length > 0) {
        callbacks.onToolStart?.(toolUseBlocks.map((b) => b.name).join(", "));

        const toolResults: ToolResultBlock[] = await Promise.all(
          toolUseBlocks.map(async (block) => {
            if (signal?.aborted) {
              return {
                type: "tool_result" as const,
                tool_use_id: block.id,
                content: "Task cancelled",
                is_error: true,
              };
            }

            console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`);
            const toolExecutor = options?.toolExecutor ?? executeTool;
            const { result, isError, terminatesLoop } = await toolExecutor(
              block.name,
              block.input as Record<string, unknown>
            );

            // Check if any tool requested early termination
            if (terminatesLoop) {
              earlyTermination = true;
            }

            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: result.slice(0, 50_000), // cap tool output
              is_error: isError,
            };
          })
        );

        callbacks.onToolEnd?.(toolUseBlocks.map((b) => b.name).join(", "));

        if (signal?.aborted) throw new TaskCancelledError("Task cancelled", newMessages);

        const toolResultMessage: Message = {
          role: "user",
          content: toolResults,
        };
        conversation.push(toolResultMessage);
        newMessages.push(toolResultMessage);

        // If a tool requested early termination, break out of the loop
        if (earlyTermination) {
          break;
        }
      }
    } catch (err) {
      // If abort fired mid-stream or mid-fetch, re-throw as TaskCancelledError with partial messages.
      // This ensures all abort exit paths carry the accumulated messages for persistence.
      if (signal?.aborted) {
        throw new TaskCancelledError("Task cancelled", newMessages);
      }
      // If not an abort, re-throw the original error
      throw err;
    }
  }

  return { messages: newMessages, inputTokens: lastInputTokens, earlyTermination };
}

/**
 * Sanitize message history to ensure strict tool_use/tool_result pairing.
 * Claude's API requires every tool_use block to have a corresponding
 * tool_result in the immediately following user message, and vice versa.
 *
 * This can happen when:
 * - loadHistory's LIMIT cuts mid tool-call pair
 * - compaction splits between a tool_use and its tool_result
 * - async event triggers a new turn with stale history
 * - a crash or timeout occurs mid tool execution
 */
function sanitizeMessages(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Check user messages that contain tool_result blocks
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter(
        (b): b is ToolResultBlock => b.type === "tool_result"
      );

      if (toolResults.length > 0) {
        // Find the preceding assistant message in our result array
        const prevAssistant = result.length > 0 ? result[result.length - 1] : null;

        if (!prevAssistant || prevAssistant.role !== "assistant" || !Array.isArray(prevAssistant.content)) {
          // No preceding assistant message — skip this entire tool_result message
          console.warn(`[sanitize] Dropping orphaned tool_result message at index ${i} — no preceding assistant message`);
          continue;
        }

        // Get tool_use IDs from the preceding assistant message
        const toolUseIds = new Set(
          prevAssistant.content
            .filter((b): b is ToolUseBlock => b.type === "tool_use")
            .map((b) => b.id)
        );

        // Filter to only tool_results that have matching tool_use blocks
        const validResults = msg.content.filter((b) => {
          if (b.type !== "tool_result") return true; // keep non-tool_result blocks
          const valid = toolUseIds.has((b as ToolResultBlock).tool_use_id);
          if (!valid) {
            console.warn(`[sanitize] Dropping orphaned tool_result for tool_use_id=${(b as ToolResultBlock).tool_use_id}`);
          }
          return valid;
        });

        if (validResults.length === 0) {
          // All tool_results were orphaned — drop the message entirely
          console.warn(`[sanitize] Dropping entire tool_result message at index ${i} — all results orphaned`);
          continue;
        }

        result.push({ role: msg.role, content: validResults });
        continue;
      }
    }

    // Check assistant messages that contain tool_use blocks — ensure the
    // next message provides matching tool_results. Orphaned tool_use blocks
    // (no tool_result follows) also cause 400 errors from the Claude API.
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const toolUseBlocks = msg.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      if (toolUseBlocks.length > 0) {
        const nextMsg = i + 1 < messages.length ? messages[i + 1] : null;
        const nextToolResultIds = new Set<string>();
        if (nextMsg && nextMsg.role === "user" && Array.isArray(nextMsg.content)) {
          for (const b of nextMsg.content) {
            if (b.type === "tool_result") {
              nextToolResultIds.add((b as ToolResultBlock).tool_use_id);
            }
          }
        }

        const orphanedToolUseIds = toolUseBlocks
          .filter((b) => !nextToolResultIds.has(b.id))
          .map((b) => b.id);

        if (orphanedToolUseIds.length > 0) {
          const cleanedContent = msg.content.filter((b) => {
            if (b.type !== "tool_use") return true;
            const orphaned = orphanedToolUseIds.includes((b as ToolUseBlock).id);
            if (orphaned) {
              console.warn(`[sanitize] Stripping orphaned tool_use id=${(b as ToolUseBlock).id}`);
            }
            return !orphaned;
          });

          if (cleanedContent.length > 0) {
            result.push({ role: msg.role, content: cleanedContent });
          } else {
            console.warn(`[sanitize] Dropping assistant message at index ${i} — only contained orphaned tool_use blocks`);
          }
          continue;
        }
      }
    }

    result.push(msg);
  }

  // Also ensure the history doesn't start with an assistant message
  // (Claude requires the first message to be from the user)
  while (result.length > 0 && result[0].role === "assistant") {
    console.warn(`[sanitize] Dropping leading assistant message`);
    result.shift();
  }

  return result;
}

export async function runAgent(messages: Message[], options?: AgentOptions, signal?: AbortSignal): Promise<AgentResult> {
  const conversation = sanitizeMessages([...messages]);
  const initialLength = conversation.length;
  const newMessages: Message[] = [];
  let lastInputTokens = 0;
  let earlyTermination = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new Error("Task cancelled");

    const response = await callClaude(conversation, options, signal, initialLength);

    // Track the latest input_tokens from the API response
    lastInputTokens = getTotalInputTokens(response.usage) || lastInputTokens;
    logUsage("lin", response.usage);

    const assistantMessage: Message = {
      role: "assistant",
      content: response.content,
    };
    conversation.push(assistantMessage);
    newMessages.push(assistantMessage);

    if (response.stop_reason !== "tool_use") {
      break;
    }

    // Execute tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );

    if (signal?.aborted) throw new Error("Task cancelled");

    const toolResults: ToolResultBlock[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        if (signal?.aborted) {
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: "Task cancelled",
            is_error: true,
          };
        }

        console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`);
        const toolExecutor = options?.toolExecutor ?? executeTool;
        const { result, isError, terminatesLoop } = await toolExecutor(
          block.name,
          block.input as Record<string, unknown>
        );

        // Check if any tool requested early termination
        if (terminatesLoop) {
          earlyTermination = true;
        }

        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result.slice(0, 50_000), // cap tool output
          is_error: isError,
        };
      })
    );

    if (signal?.aborted) throw new Error("Task cancelled");

    const toolResultMessage: Message = {
      role: "user",
      content: toolResults,
    };
    conversation.push(toolResultMessage);
    newMessages.push(toolResultMessage);

    // If a tool requested early termination, break out of the loop
    if (earlyTermination) {
      break;
    }
  }

  return { messages: newMessages, inputTokens: lastInputTokens, earlyTermination };
}

export function extractTextFromResponse(messages: Message[]): string {
  // Collect text blocks from all assistant messages in order
  const allTextParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
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
