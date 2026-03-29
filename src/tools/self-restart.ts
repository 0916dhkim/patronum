/**
 * self_restart tool — rebuild and restart the bot process.
 *
 * Flow:
 * 1. Run `npm run build` in the source directory
 * 2. If build fails, return error (no restart)
 * 3. If build succeeds, set a pending restart flag
 * 4. The bot sends the reply to Telegram, THEN calls process.exit(0)
 * 5. systemd Restart=always brings the process back
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { config } from "../config.js";
import type { ToolHandler } from "../types.js";

let _pendingRestart = false;

/** Check if a restart is pending (call after message is sent) */
export function isRestartPending(): boolean {
  return _pendingRestart;
}

/** Execute the pending restart (call after message delivery is confirmed) */
export function executeRestart(): void {
  if (!_pendingRestart) return;
  console.log("[self_restart] Message delivered, exiting for restart...");
  process.exit(0);
}

export const selfRestartTool: ToolHandler = {
  definition: {
    name: "self_restart",
    description:
      "Rebuild and restart the bot. Use after editing source code. " +
      "Runs `npm run build` first — if the build fails, the restart is aborted " +
      "and you get the build error to fix. If the build succeeds, the reply is " +
      "sent first, then the process exits and restarts automatically.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief description of why you're restarting (logged)",
        },
      },
      required: [],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const reason = (input.reason as string) || "no reason given";
    const sourceDir = path.join(config.workspace, "source");

    console.log(`[self_restart] Restart requested: ${reason}`);

    // Step 1: Build
    try {
      console.log("[self_restart] Running npm run build...");
      execSync("npm run build", {
        cwd: sourceDir,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log("[self_restart] Build succeeded, restart pending (waiting for message delivery)");
    } catch (err: any) {
      const stderr = err.stderr || err.message || String(err);
      console.error("[self_restart] Build failed:", stderr);
      return `Build failed — restart aborted.\n\n${stderr}`;
    }

    // Step 2: Set flag — bot.ts will call executeRestart() after sending the reply
    _pendingRestart = true;

    return `Build succeeded. Restarting after this message is delivered (reason: ${reason}).`;
  },
};
