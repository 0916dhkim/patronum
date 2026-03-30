import type { ToolHandler, ToolDefinition } from "../types.js";
import { execTool } from "./exec.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { sendMediaTool, setBot, setSendMediaChatId } from "./send-media.js";
import { spawnAgentTool, setSpawnCallback } from "./spawn-agent.js";
import { cancelAgentTool } from "./cancel-agent.js";
import { listTasksTool } from "./list-tasks.js";
import { memorySearchTool, memoryWriteTool } from "../memory/index.js";
import { selfRestartTool } from "./self-restart.js";
import { searchTool } from "./search.js";

export { setCurrentChatId, getCurrentChatId } from "./chat-context.js";
export { setBot, setSendMediaChatId };
export { setSpawnCallback };

const tools: ToolHandler[] = [
  execTool,
  readTool,
  writeTool,
  editTool,
  sendMediaTool,
  spawnAgentTool,
  cancelAgentTool,
  listTasksTool,
  memorySearchTool,
  memoryWriteTool,
  selfRestartTool,
  searchTool,
];

const toolMap = new Map<string, ToolHandler>(
  tools.map((t) => [t.definition.name, t])
);

export function getToolDefinitions(): ToolDefinition[] {
  return tools.map((t) => t.definition);
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<{ result: string; isError: boolean }> {
  const handler = toolMap.get(name);
  if (!handler) {
    return { result: `Unknown tool: ${name}`, isError: true };
  }

  try {
    const result = await handler.execute(input);
    return { result, isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: msg, isError: true };
  }
}
