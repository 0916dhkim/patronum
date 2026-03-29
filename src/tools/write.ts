import fs from "fs/promises";
import path from "path";
import type { ToolHandler } from "../types.js";
import { config } from "../config.js";

export const writeTool: ToolHandler = {
  definition: {
    name: "write",
    description:
      "Write content to a file. Creates parent directories if needed. Path is relative to the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (relative to workspace or absolute)",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },

  async execute(input): Promise<string> {
    const filePath = input.path as string;
    const content = input.content as string;
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(config.workspace, filePath);

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
    return `Wrote ${content.length} bytes to ${resolved}`;
  },
};
