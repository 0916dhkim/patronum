import { config } from "./config.js";
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

const SYSTEM_PROMPT = `You are a helpful personal AI assistant. You have access to tools for running shell commands, reading/writing files, and editing files. Use them when needed to help the user. Be concise and direct.`;

async function callClaude(messages: Message[]): Promise<ClaudeResponse> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.claudeToken}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
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

export async function runAgent(messages: Message[]): Promise<Message[]> {
  const conversation = [...messages];
  const newMessages: Message[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await callClaude(conversation);

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

  return newMessages;
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
