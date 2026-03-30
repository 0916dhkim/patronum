import fs from "node:fs";
import path from "node:path";
import { initConfig, config } from "./config.js";
import { resetAgentsCache } from "./agents.js";
import { startBot } from "./bot.js";
import { DEFAULT_SOUL, DEFAULT_AGENTS } from "./templates.js";

const DEFAULTS: Record<string, string> = {
  "SOUL.md": DEFAULT_SOUL,
  "AGENTS.md": DEFAULT_AGENTS,
};

function ensureWorkspaceFiles(): void {
  for (const [filename, content] of Object.entries(DEFAULTS)) {
    const dest = path.join(config.workspace, filename);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, "utf-8");
      console.log(`[patronum] Created default ${filename} in workspace`);
    }
  }
}

console.log("[patronum] Starting...");
initConfig()
  .then(() => {
    // Reset agent cache so models are resolved with the now-loaded config
    resetAgentsCache();
    ensureWorkspaceFiles();
    return startBot();
  })
  .catch((err) => {
    console.error("[patronum] Fatal:", err);
    process.exit(1);
  });
