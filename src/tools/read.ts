import fs from "fs/promises";
import path from "path";
import type { ToolHandler } from "../types.js";
import { config } from "../config.js";

export const readTool: ToolHandler = {
  definition: {
    name: "read",
    description: "Read the contents of a file. Path is relative to the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (relative to workspace or absolute)",
        },
      },
      required: ["path"],
    },
  },

  async execute(input): Promise<string> {
    const filePath = input.path as string;
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(config.workspace, filePath);

    try {
      const content = await fs.readFile(resolved, "utf-8");
      if (content.length > 100_000) {
        return content.slice(0, 100_000) + "\n[truncated at 100KB]";
      }
      return content;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read ${resolved}: ${msg}`);
    }
  },
};
