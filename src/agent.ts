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

  // Append any extra context (thread, etc.)
  if (options?.extraContext) {
    for (const ctx of options.extraContext) {
      if (ctx) system.push({ type: "text", text: ctx });
    }
  }

  return system;
}

async function callClaude(messages: Message[], options?: AgentOptions): Promise<ClaudeResponse> {
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

export async function runAgent(messages: Message[], options?: AgentOptions): Promise<AgentResult> {
  const conversation = [...messages];
  const newMessages: Message[] = [];
  let lastInputTokens = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await callClaude(conversation, options);

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

    const toolResults: ToolResultBlock[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
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
