import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { AGENTS } from "./agents.js";
import { loadThread, appendToThread, formatThreadForContext } from "./thread.js";
import type { ThreadMessage } from "./thread.js";
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
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function loadAgentContextFile(workspaceDir: string, filename: string): string | null {
  try {
    const filePath = path.join(workspaceDir, filename);
    return fs.readFileSync(filePath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function buildAgentSystemPrompt(
  agentName: string,
  threadContext: string
): Array<{ type: "text"; text: string }> {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  const system: Array<{ type: "text"; text: string }> = [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ];

  // Load agent's SOUL.md
  const soul = loadAgentContextFile(agent.workspaceDir, "SOUL.md");
  if (soul) system.push({ type: "text", text: soul });

  // Load agent's AGENTS.md
  const agents = loadAgentContextFile(agent.workspaceDir, "AGENTS.md");
  if (agents) system.push({ type: "text", text: agents });

  // Include the shared thread as context
  if (threadContext) {
    system.push({ type: "text", text: threadContext });
  }

  return system;
}

async function callClaudeForAgent(
  agentName: string,
  messages: Message[],
  systemPrompt: Array<{ type: "text"; text: string }>,
  signal?: AbortSignal
): Promise<ClaudeResponse> {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  // Agents get tools too — they can read/write/exec
  const tools = getToolDefinitions();

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
    body: JSON.stringify({
      model: agent.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error ${response.status} for agent ${agentName}: ${body}`);
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
 * Run a specialist agent within the shared thread context (SYNCHRONOUS version).
 *
 * 1. Loads the full thread for context
 * 2. Optionally appends a new user prompt to the thread
 * 3. Runs the agent with tool loops
 * 4. Appends only the agent's final text output to the thread
 * 5. Returns that text
 */
export async function runAgentInThread(
  agentName: string,
  chatId: string,
  userPrompt?: string,
  signal?: AbortSignal
): Promise<string> {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  // Check abort before starting
  if (signal?.aborted) throw new Error("Task cancelled");

  // Optionally append the task/prompt to the thread
  if (userPrompt) {
    // The task briefing from lin goes to thread as lin's message
    appendToThread(chatId, "lin", userPrompt);
  }

  // Load thread and format as context
  const thread = loadThread(chatId);
  const threadContext = formatThreadForContext(thread);

  // Build system prompt with agent identity + thread context
  const systemPrompt = buildAgentSystemPrompt(agentName, threadContext);

  // The agent sees the task as a user message in its conversation
  const taskMessage = userPrompt || "Please review the conversation thread and provide your input.";
  const messages: Message[] = [
    { role: "user", content: taskMessage },
  ];

  // Run agent loop (with tool use)
  let lastAssistantContent: ContentBlock[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check abort before each API call
    if (signal?.aborted) throw new Error("Task cancelled");

    const response = await callClaudeForAgent(agentName, messages, systemPrompt, signal);

    const assistantMessage: Message = {
      role: "assistant",
      content: response.content,
    };
    messages.push(assistantMessage);
    lastAssistantContent = response.content;

    if (response.stop_reason !== "tool_use") {
      break;
    }

    // Check abort before tool execution
    if (signal?.aborted) throw new Error("Task cancelled");

    // Execute tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: ToolResultBlock[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        // Check abort before each tool
        if (signal?.aborted) {
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: "Task cancelled",
            is_error: true,
          };
        }

        console.log(`[agent:${agentName}:tool] ${block.name}(${JSON.stringify(block.input)})`);
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

    // Check abort after tool execution
    if (signal?.aborted) throw new Error("Task cancelled");

    const toolResultMessage: Message = {
      role: "user",
      content: toolResults,
    };
    messages.push(toolResultMessage);
  }

  // Extract final text and append to thread
  const finalText = extractFinalText(lastAssistantContent);
  if (finalText) {
    appendToThread(chatId, agentName as "alex" | "iris" | "quill", finalText);
  }

  return finalText || "(no response from agent)";
}

/**
 * Run a specialist agent with a pre-built thread snapshot (ASYNC version).
 * Does NOT append to the live thread — the caller (task-manager flow) handles that.
 */
export async function runAgentWithSnapshot(
  agentName: string,
  chatId: string,
  userPrompt: string,
  threadSnapshot: ThreadMessage[],
  signal?: AbortSignal
): Promise<string> {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  if (signal?.aborted) throw new Error("Task cancelled");

  // Format snapshot as context (not the live thread)
  const threadContext = formatThreadForContext(threadSnapshot);

  // Build system prompt with agent identity + snapshot context
  const systemPrompt = buildAgentSystemPrompt(agentName, threadContext);

  const messages: Message[] = [
    { role: "user", content: userPrompt },
  ];

  let lastAssistantContent: ContentBlock[] = [];

  while (true) {
    if (signal?.aborted) throw new Error("Task cancelled");

    const response = await callClaudeForAgent(agentName, messages, systemPrompt, signal);

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

        console.log(`[agent:${agentName}:tool] ${block.name}(${JSON.stringify(block.input)})`);
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

  const finalText = extractFinalText(lastAssistantContent);
  return finalText || "(no response from agent)";
}
