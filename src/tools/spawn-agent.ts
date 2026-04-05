import type { ToolHandler } from "../types.js";
import { getAgentsDir, getSubagentSetupHint, listAgentDefs } from "../agents.js";
import { taskManager } from "../task-manager.js";
import { getOrCreateThread, appendToAgentThread } from "../agent-thread.js";
import { getCurrentChatId } from "./chat-context.js";

// The actual execution callback is set by bot.ts to avoid circular imports
let spawnCallback: ((taskId: string, agentName: string, task: string, chatId: string) => void) | null = null;

export function setSpawnCallback(cb: typeof spawnCallback): void {
  spawnCallback = cb;
}

export const spawnAgentTool: ToolHandler = {
  definition: {
    name: "spawn_agent",
    description:
      "Spawn a specialist agent as a background task. Returns immediately with a taskId. You will be notified when it completes. The agent receives the named thread as context — all agents on the same thread see each other's work.",
    input_schema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["alex", "iris", "junior", "quill"], // static fallback — overridden at runtime by getSubagentNames()
          description: "Which specialist agent to spawn",
        },
        task: {
          type: "string",
          description: "What to ask the agent to do",
        },
        thread: {
          type: "string",
          description: "Name of the agent thread for coordination context. All agents on the same thread see each other's work.",
        },
      },
      required: ["agent", "task", "thread"],
    },
  },

  async execute(input): Promise<string> {
    const agentName = input.agent as string;
    const task = input.task as string;
    const threadName = input.thread as string;
    const chatId = getCurrentChatId();

    if (!chatId) {
      return "Error: No chat context available for agent invocation";
    }

    const agentDefs = listAgentDefs();
    if (agentDefs.length === 0) {
      return `Error: No subagents configured in ${getAgentsDir()}. ${getSubagentSetupHint()}`;
    }

    const agentDef = agentDefs.find((agent) => agent.name === agentName);
    if (!agentDef) {
      const agentNames = agentDefs.map((agent) => agent.name);
      return `Error: Unknown agent "${agentName}". Available: ${agentNames.join(", ")}`;
    }

    if (!spawnCallback) {
      return "Error: Spawn callback not registered (bot not initialized)";
    }

    // Get or create the named agent thread
    const thread = getOrCreateThread(chatId, threadName);

    // Append Lin's task briefing to the agent thread
    appendToAgentThread(thread.id, "lin", task);

    // Include thread name in the task string so the agent knows what to read
    const taskWithThread = `${task}\n\n[Thread: ${threadName}]`;

    // Register task in TaskManager
    const agentTask = taskManager.spawn(agentDef, taskWithThread, chatId, thread.id, threadName);

    console.log(
      `[spawn_agent] Spawned ${agentName} as task ${agentTask.taskId} (thread: ${threadName}): ${task.slice(0, 100)}`
    );

    // Trigger background execution (non-blocking)
    spawnCallback(agentTask.taskId, agentName, taskWithThread, chatId);

    return `Task ${agentTask.taskId} spawned (thread: ${threadName}). ${agentName.charAt(0).toUpperCase() + agentName.slice(1)} is working on it in the background. You'll be notified when it completes.`;
  },
};
