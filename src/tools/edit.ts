import fs from "fs/promises";
import path from "path";
import type { ToolHandler } from "../types.js";
import { config } from "../config.js";

export const editTool: ToolHandler = {
  definition: {
    name: "edit",
    description:
      "Find and replace text in a file. The old_text must match exactly (including whitespace).",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (relative to workspace or absolute)",
        },
        old_text: {
          type: "string",
          description: "Exact text to find",
        },
        new_text: {
          type: "string",
          description: "Text to replace it with",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
  },

  async execute(input): Promise<string> {
    const filePath = input.path as string;
    const oldText = input.old_text as string;
    const newText = input.new_text as string;
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(config.workspace, filePath);

    const content = await fs.readFile(resolved, "utf-8");

    if (!content.includes(oldText)) {
      throw new Error(`old_text not found in ${resolved}`);
    }

    const updated = content.replace(oldText, newText);
    await fs.writeFile(resolved, updated, "utf-8");
    return `Edited ${resolved}`;
  },
};
