import fs from "node:fs";
import path from "node:path";

export function loadContextFile(workspace: string, filename: string): string | null {
  try {
    const filePath = path.join(workspace, filename);
    return fs.readFileSync(filePath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
