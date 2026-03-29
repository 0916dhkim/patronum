import type { ToolHandler } from "../types.js";
import { taskManager } from "../task-manager.js";

export const cancelAgentTool: ToolHandler = {
  definition: {
    name: "cancel_agent",
    description:
      "Cancel a running background agent task. Use the taskId returned by spawn_agent.",
    input_schema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to cancel",
        },
      },
      required: ["taskId"],
    },
  },

  async execute(input): Promise<string> {
    const taskId = input.taskId as string;
    const message = taskManager.cancel(taskId);
    console.log(`[cancel_agent] ${message}`);
    return message;
  },
};
