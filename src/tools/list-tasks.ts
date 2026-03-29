import type { ToolHandler } from "../types.js";
import { taskManager } from "../task-manager.js";
import { getCurrentChatId } from "./chat-context.js";

export const listTasksTool: ToolHandler = {
  definition: {
    name: "list_tasks",
    description:
      "List all active and recent background agent tasks for this conversation. Shows task IDs, agents, status, and duration.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  async execute(): Promise<string> {
    const chatId = getCurrentChatId();
    if (!chatId) {
      return "Error: No chat context available";
    }

    const tasks = taskManager.listTasks(chatId);

    if (tasks.length === 0) {
      return "No tasks found for this conversation.";
    }

    const lines = tasks.map((t) => {
      const duration = t.completedAt
        ? `${((t.completedAt - t.startedAt) / 1000).toFixed(1)}s`
        : `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s (running)`;

      let statusLabel = t.status as string;
      if (t.status === "done") statusLabel = "✅ done";
      else if (t.status === "running") statusLabel = "⏳ running";
      else if (t.status === "failed") statusLabel = "❌ failed";
      else if (t.status === "cancelled") statusLabel = "🚫 cancelled";

      let line = `• ${t.taskId} | ${t.agent} | ${statusLabel} | ${duration}`;
      line += `\n  Task: ${t.task.slice(0, 100)}`;

      if (t.error) {
        line += `\n  Error: ${t.error.slice(0, 200)}`;
      }

      return line;
    });

    return lines.join("\n\n");
  },
};
