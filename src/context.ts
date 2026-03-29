import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SOUL, DEFAULT_AGENTS } from "./templates.js";

const TEMPLATES: Record<string, string> = {
  "SOUL.md": DEFAULT_SOUL,
  "AGENTS.md": DEFAULT_AGENTS,
};

/**
 * Load a context file from the workspace.
 * Falls back to the built-in template if the file doesn't exist.
 */
export function loadContextFile(workspace: string, filename: string): string | null {
  try {
    const filePath = path.join(workspace, filename);
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (content) return content;
  } catch {
    // File doesn't exist — fall through to template
  }

  // Fall back to default template
  return TEMPLATES[filename] ?? null;
}
