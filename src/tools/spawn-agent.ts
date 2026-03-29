import type { ToolHandler } from "../types.js";
import { taskManager } from "../task-manager.js";
import { loadThread } from "../thread.js";
import { getCurrentChatId } from "./run-agent.js";

// The actual execution callback is set by bot.ts to avoid circular imports
let spawnCallback: ((taskId: string, agentName: string, task: string, chatId: string) => void) | null = null;

export function setSpawnCallback(cb: typeof spawnCallback): void {
  spawnCallback = cb;
}

export const spawnAgentTool: ToolHandler = {
  definition: {
    name: "spawn_agent",
    description:
      "Spawn a specialist agent as a background task. Returns immediately with a taskId. You will be notified when it completes. Use this for parallel work — you can spawn multiple agents simultaneously. The agent gets a snapshot of the current conversation thread.",
    input_schema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["alex", "iris", "quill"],
          description: "Which specialist agent to spawn",
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
    const chatId = getCurrentChatId();

    if (!chatId) {
      return "Error: No chat context available for agent invocation";
    }

    if (!["alex", "iris", "quill"].includes(agentName)) {
      return `Error: Unknown agent "${agentName}". Available: alex, iris, quill`;
    }

    if (!spawnCallback) {
      return "Error: Spawn callback not registered (bot not initialized)";
    }

    // Snapshot the thread at this moment
    const threadSnapshot = loadThread(chatId);

    // Register task in TaskManager
    const agentTask = taskManager.spawn(agentName, task, chatId, threadSnapshot);

    console.log(`[spawn_agent] Spawned ${agentName} as task ${agentTask.taskId}: ${task.slice(0, 100)}`);

    // Trigger background execution (non-blocking)
    spawnCallback(agentTask.taskId, agentName, task, chatId);

    return `Task ${agentTask.taskId} spawned. ${agentName.charAt(0).toUpperCase() + agentName.slice(1)} is working on it in the background. You'll be notified when it completes.`;
  },
};
