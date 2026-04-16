import { config } from "./config.js";
import { getAgentDef, type AgentDef } from "./agents.js";
import { getToolDefinitions, executeTool, setCurrentChatId } from "./tools/index.js";
import {
  logUsage,
  prepareMessagesForClaude,
  prepareSystemPromptForClaude,
} from "./prompt-cache.js";
import { persistSubagentMessages } from "./agent-thread.js";
import type {
  Message,
  ClaudeResponse,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  TextBlock,
} from "./types.js";


const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 48000; // Must be greater than thinking budget_tokens (32000) + output capacity
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function buildAgentSystemPrompt(agent: AgentDef): TextBlock[] {
  const system: TextBlock[] = [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ];

  // Use the system prompt from SUBAGENT.md body
  if (agent.systemPrompt) {
    system.push({ type: "text", text: agent.systemPrompt });
  }

  return system;
}

// Tools that only Lin (the orchestrator) should have. Subagents must not spawn
// other agents, restart the bot, or manage tasks — those are orchestration concerns.
const SUBAGENT_BLOCKED_TOOLS = new Set([
  "spawn_agent",
  "self_restart",
  "cancel_agent",
  "list_tasks",
]);

async function callClaudeForAgent(
  agent: AgentDef,
  messages: Message[],
  systemPrompt: Array<{ type: "text"; text: string }>,
  signal?: AbortSignal,
  toolChoice?: { type: "tool"; name: string } | { type: "auto" }
): Promise<ClaudeResponse> {
  // Agents get tools — but not orchestration tools (spawn_agent, self_restart, etc.)
  const originalTools = getToolDefinitions().filter(
    (t) => !SUBAGENT_BLOCKED_TOOLS.has(t.name)
  );
  
  // Clone the tools array and add cache_control to the last tool
  const tools = originalTools.map((tool) => ({ ...tool }));
  if (tools.length > 0) {
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      cache_control: { type: "ephemeral" },
    };
  }

  const body: Record<string, unknown> = {
    model: agent.model,
    max_tokens: MAX_TOKENS,
    system: prepareSystemPromptForClaude(systemPrompt),
    tools,
    messages: prepareMessagesForClaude(messages),
  };

  // Add tool_choice if specified
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }

  // Add thinking if enabled for this agent — but NOT when tool_choice forces a specific tool,
  // as the Anthropic API does not allow thinking + forced tool_choice simultaneously.
  if (agent.thinking && toolChoice?.type !== "tool") {
    body.thinking = { type: "enabled", budget_tokens: 32000 };
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.claudeToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta":
        "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/2.1.85",
      "x-app": "cli",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error ${response.status} for agent ${agent.name}: ${body}`);
  }

  return (await response.json()) as ClaudeResponse;
}

/**
 * Extract only the text content from an assistant response (no tool calls).
 */
function extractFinalText(content: ContentBlock[]): string {
  const textParts = content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text);
  return textParts.join("\n").trim();
}

/**
 * Redact secrets from a tool result string.
 * Truncate to a reasonable limit.
 */
function sanitizeToolResult(content: string): string {
  // Redact common secret patterns
  let sanitized = content
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED]")
    // API keys (sk-* covers sk-ant-*, sk-prod-*, etc.)
    .replace(/sk-[A-Za-z0-9\-._~+/]+=*/g, "sk-[REDACTED]")
    .replace(/(key|token|password|apikey|secret)\s*=\s*[^\s,\]}'"]*/gi, "$1=[REDACTED]");

  // Truncate to 10k chars if needed
  if (sanitized.length > 10000) {
    sanitized = sanitized.slice(0, 10000) + "\n[... truncated ...]";
  }

  return sanitized;
}

/**
 * Sanitize an object by redacting values for sensitive keys.
 */
function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeyPattern = /^(password|token|secret|apikey)$/i;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeyPattern.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Sanitize a ContentBlock by redacting secrets in tool results and tool_use inputs.
 */
function sanitizeContentBlock(block: ContentBlock): ContentBlock {
  if (block.type === "tool_result") {
    // If content is a string, sanitize it
    if (typeof block.content === "string") {
      return {
        ...block,
        content: sanitizeToolResult(block.content),
      };
    }
  } else if (block.type === "tool_use") {
    // Sanitize tool_use input for sensitive keys
    return {
      ...block,
      input: sanitizeObject(block.input as Record<string, unknown>),
    };
  }
  return block;
}

/**
 * Filter out thinking blocks from content and sanitize tool results.
 */
function filterAndSanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content
    // Remove thinking and redacted_thinking blocks
    .filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking")
    // Sanitize remaining blocks
    .map(sanitizeContentBlock);
}

/**
 * Run a specialist agent with a named thread context.
 * The agent's first API call is forced to call read_agent_thread,
 * which loads the thread live from the DB.
 */
export async function runAgentWithThread(
  agent: AgentDef,
  chatId: string,
  userPrompt: string,
  threadId: string,
  threadName: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) throw new Error("Task cancelled");

  // Set chat context so tools know which chat this agent belongs to
  setCurrentChatId(chatId);

  // Build system prompt (no thread context — it arrives via tool)
  const systemPrompt = buildAgentSystemPrompt(agent);

  const messages: Message[] = [{ role: "user", content: userPrompt }];

  let lastAssistantContent: ContentBlock[] = [];
  let isFirstCall = true;

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Task cancelled");

      // Force read_agent_thread on the first call
      const toolChoice = isFirstCall
        ? ({ type: "tool", name: "read_agent_thread" } as const)
        : undefined;

      const response = await callClaudeForAgent(agent, messages, systemPrompt, signal, toolChoice);
      logUsage(`agent:${agent.name}`, response.usage);
      isFirstCall = false;

      const assistantMessage: Message = {
        role: "assistant",
        content: response.content,
      };
      messages.push(assistantMessage);
      lastAssistantContent = response.content;

      if (response.stop_reason !== "tool_use") {
        break;
      }

      if (signal?.aborted) throw new Error("Task cancelled");

      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

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

          console.log(`[agent:${agent.name}:tool] ${block.name}(${JSON.stringify(block.input)})`);
          const { result, isError } = await executeTool(
            block.name,
            block.input as Record<string, unknown>
          );
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: result.slice(0, 50_000),
            is_error: isError,
          };
        })
      );

      if (signal?.aborted) throw new Error("Task cancelled");

      const toolResultMessage: Message = {
        role: "user",
        content: toolResults,
      };
      messages.push(toolResultMessage);
    }
  } finally {
    // Sanitize and persist the internal message array, regardless of success or failure
    const sanitizedMessages = messages.map((msg) => {
      if (typeof msg.content === "string") {
        return msg;
      }
      return {
        ...msg,
        content: filterAndSanitizeContent(msg.content),
      };
    });

    persistSubagentMessages(threadId, agent.name, sanitizedMessages);
  }

  const finalText = extractFinalText(lastAssistantContent);
  return finalText || "(no response from agent)";
}
