import type { ToolHandler } from "../types.js";
import { findThread, formatAgentThread, listActiveThreads } from "../agent-thread.js";
import { getCurrentChatId } from "./chat-context.js";

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays}d ago`;
  } else if (diffHours > 0) {
    return `${diffHours}h ago`;
  } else if (diffMinutes > 0) {
    return `${diffMinutes}m ago`;
  } else {
    return "just now";
  }
}

export const readAgentThreadTool: ToolHandler = {
  definition: {
    name: "read_agent_thread",
    description:
      "Read the full content of an agent thread. Use this after agent completions to review what was done, or before spawning the next agent in a loop.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the agent thread to read",
        },
      },
      required: ["name"],
    },
  },

  async execute(input): Promise<string> {
    const threadName = input.name as string;
    const chatId = getCurrentChatId();

    if (!chatId) {
      return "Error: No chat context available";
    }

    const thread = findThread(chatId, threadName);
    if (!thread) {
      return `No agent thread named '${threadName}' found. Use list_agent_threads to see active threads.`;
    }

    return formatAgentThread(thread.id, threadName);
  },
};

export const listAgentThreadsTool: ToolHandler = {
  definition: {
    name: "list_agent_threads",
    description:
      "List all active agent threads for this chat. Shows name, message count, and last activity.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  async execute(): Promise<string> {
    const chatId = getCurrentChatId();

    if (!chatId) {
      return "Error: No chat context available";
    }

    const threads = listActiveThreads(chatId);

    if (threads.length === 0) {
      return "No active agent threads.";
    }

    const lines = threads.map(
      (t) =>
        `• ${t.name} — ${t.messageCount} messages, last activity ${getRelativeTime(t.lastActivity)}`
    );

    return `Active agent threads:\n${lines.join("\n")}`;
  },
};
