import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig, config } from "./config.js";
import { startBot } from "./bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function copyDefaultsToWorkspace(): void {
  for (const file of ["SOUL.md", "AGENTS.md"]) {
    const dest = path.join(config.workspace, file);
    if (!fs.existsSync(dest)) {
      const src = path.join(PROJECT_ROOT, file);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`[patronum] Copied default ${file} to workspace`);
      }
    }
  }
}

console.log("[patronum] Starting...");
initConfig()
  .then(() => {
    copyDefaultsToWorkspace();
    return startBot();
  })
  .catch((err) => {
    console.error("[patronum] Fatal:", err);
    process.exit(1);
  });
