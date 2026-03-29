import type { ToolHandler } from "../types.js";
import { runAgentInThread } from "../run-agent.js";

// Chat ID is set by the bot before tool execution
let currentChatId: string = "";

export function setCurrentChatId(chatId: string): void {
  currentChatId = chatId;
}

export function getCurrentChatId(): string {
  return currentChatId;
}

export const runAgentTool: ToolHandler = {
  definition: {
    name: "run_agent",
    description:
      "Invoke a specialist agent (alex/iris/quill) to work on a task. The agent will have full conversation thread context and can use tools (read, write, exec, edit). Returns their response.",
    input_schema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["alex", "iris", "quill"],
          description: "Which specialist agent to invoke",
        },
        task: {
          type: "string",
          description: "What to ask the agent to do",
        },
      },
      required: ["agent", "task"],
    },
  },

  async execute(input): Promise<string> {
    const agentName = input.agent as string;
    const task = input.task as string;

    if (!currentChatId) {
      return "Error: No chat context available for agent invocation";
    }

    if (!["alex", "iris", "quill"].includes(agentName)) {
      return `Error: Unknown agent "${agentName}". Available: alex, iris, quill`;
    }

    console.log(`[run_agent] Invoking ${agentName} with task: ${task.slice(0, 100)}`);

    try {
      const response = await runAgentInThread(agentName, currentChatId, task);
      console.log(`[run_agent] ${agentName} responded (${response.length} chars)`);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[run_agent] ${agentName} failed:`, msg);
      return `Agent ${agentName} encountered an error: ${msg}`;
    }
  },
};
