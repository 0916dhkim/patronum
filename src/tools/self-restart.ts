/**
 * self_restart tool — rebuild and restart the bot process.
 *
 * Flow:
 * 1. Run `npm run build` in the source directory
 * 2. If build fails, return error (no restart)
 * 3. If build succeeds, exit the process — systemd (Restart=always) brings it back
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { config } from "../config.js";
import type { ToolHandler } from "../types.js";

export const selfRestartTool: ToolHandler = {
  definition: {
    name: "self_restart",
    description:
      "Rebuild and restart the bot. Use after editing source code. " +
      "Runs `npm run build` first — if the build fails, the restart is aborted " +
      "and you get the build error to fix. If the build succeeds, the process " +
      "exits and the process supervisor restarts it automatically.",
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
      console.log("[self_restart] Build succeeded");
    } catch (err: any) {
      const stderr = err.stderr || err.message || String(err);
      console.error("[self_restart] Build failed:", stderr);
      return `Build failed — restart aborted.\n\n${stderr}`;
    }

    // Step 2: Exit — systemd Restart=always brings us back
    console.log(`[self_restart] Build succeeded, exiting for restart (reason: ${reason})`);

    setTimeout(() => {
      process.exit(0);
    }, 1000);

    return `Build succeeded. Restarting now (reason: ${reason}). I'll be back in a few seconds.`;
  },
};
