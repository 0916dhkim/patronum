import { config } from "./config.js";
import { loadContextFile } from "./context.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";
import type {
  Message,
  ClaudeResponse,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "./types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 8192;

// OAuth tokens require the Claude Code identity system prompt to access sonnet/opus models
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface AgentOptions {
  /** Override the model (defaults to config.claudeModel) */
  model?: string;
  /** Override workspace for loading SOUL.md/AGENTS.md */
  workspace?: string;
  /** Additional system context blocks (e.g. thread context) */
  extraContext?: string[];
}

function buildSystemPrompt(options?: AgentOptions): Array<{ type: "text"; text: string }> {
  const workspace = options?.workspace || config.workspace;

  const system: Array<{ type: "text"; text: string }> = [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ];
  const soul = loadContextFile(workspace, "SOUL.md");
  if (soul) system.push({ type: "text", text: soul });
  const agents = loadContextFile(workspace, "AGENTS.md");
  if (agents) system.push({ type: "text", text: agents });
  const memory = loadContextFile(workspace, "MEMORY.md");
  if (memory) system.push({ type: "text", text: `[MEMORY.md — curated persistent facts]\n\n${memory}` });

  // Append any extra context (thread, etc.)
  if (options?.extraContext) {
    for (const ctx of options.extraContext) {
      if (ctx) system.push({ type: "text", text: ctx });
    }
  }

  return system;
}

async function callClaude(messages: Message[], options?: AgentOptions, signal?: AbortSignal): Promise<ClaudeResponse> {
  const model = options?.model || config.claudeModel;

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
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(options),
      tools: getToolDefinitions(),
      messages,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error ${response.status}: ${body}`);
  }

  return (await response.json()) as ClaudeResponse;
}

export interface AgentResult {
  messages: Message[];
  inputTokens: number;
}

/**
 * Sanitize message history to ensure every tool_result has a matching tool_use
 * in the immediately preceding assistant message. Claude's API requires this
 * strict pairing — orphaned tool_results cause 400 errors.
 *
 * This can happen when:
 * - loadHistory's LIMIT cuts mid tool-call pair
 * - compaction splits between a tool_use and its tool_result
 * - async event triggers a new Lin turn with stale history
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
  const newMessages: Message[] = [];
  let lastInputTokens = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new Error("Task cancelled");

    const response = await callClaude(conversation, options, signal);

    // Track the latest input_tokens from the API response
    lastInputTokens = response.usage?.input_tokens ?? lastInputTokens;

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
        const { result, isError } = await executeTool(
          block.name,
          block.input as Record<string, unknown>
        );
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
  }

  return { messages: newMessages, inputTokens: lastInputTokens };
}

export function extractTextFromResponse(messages: Message[]): string {
  // Get the last assistant message and extract text blocks
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }
  }
  return "(no response)";
}
