import { initConfig } from "./config.js";
import { startBot } from "./bot.js";

console.log("[patronum] Starting...");
initConfig()
  .then(() => startBot())
  .catch((err) => {
    console.error("[patronum] Fatal:", err);
    process.exit(1);
  });
