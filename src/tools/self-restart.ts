/**
 * self_restart tool — rebuild and restart the bot process.
 *
 * Flow:
 * 1. Run `npm run build` in the source directory
 * 2. If build fails, return error (no restart)
 * 3. Save restart context (what we were doing + what to do next)
 * 4. Set pending flag — bot short-circuits, sends reason, exits
 * 5. On next boot, the resume context is injected back
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ToolHandler } from "../types.js";

let _pendingRestart = false;
let _restartMessage = "";

/** Check if a restart is pending */
export function isRestartPending(): boolean {
  return _pendingRestart;
}

/** Get the message to send before restarting */
export function getRestartMessage(): string {
  return _restartMessage;
}

/** Execute the pending restart (call after message delivery is confirmed) */
export function executeRestart(): void {
  if (!_pendingRestart) return;
  console.log("[self_restart] Message delivered, exiting for restart...");
  process.exit(0);
}

export interface RestartState {
  reason: string;
  resumeContext: string;
  chatId: string;
  timestamp: number;
}

function getRestartStatePath(): string {
  return path.join(config.workspace, ".restart-state.json");
}

/** Save state so we can resume after restart */
export function saveRestartState(state: RestartState): void {
  fs.writeFileSync(getRestartStatePath(), JSON.stringify(state, null, 2), "utf-8");
  console.log(`[self_restart] Saved restart state: ${state.reason}`);
}

/** Load and clear restart state (called on boot) */
export function loadRestartState(): RestartState | null {
  const statePath = getRestartStatePath();
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw) as RestartState;

    // Clear the state file so we don't re-trigger on next boot
    fs.unlinkSync(statePath);
    console.log(`[self_restart] Loaded restart state: ${state.reason}`);

    // Ignore stale state (older than 5 minutes)
    if (Date.now() - state.timestamp > 5 * 60 * 1000) {
      console.log("[self_restart] Restart state too old, ignoring");
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

export const selfRestartTool: ToolHandler = {
  definition: {
    name: "self_restart",
    description:
      "Rebuild and restart the bot. Use after editing source code. " +
      "Runs `npm run build` first — if the build fails, the restart is aborted " +
      "and you get the build error to fix. If the build succeeds, your message " +
      "is sent, then the process restarts. After restart, you'll receive the " +
      "resume context and can continue where you left off.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason for restart — this is sent to the user before shutdown",
        },
        resume_context: {
          type: "string",
          description:
            "Context for yourself after restart — what you were doing and what to do next. " +
            "You lose all in-flight state on restart, so put everything you need here.",
        },
      },
      required: ["reason"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const reason = (input.reason as string) || "no reason given";
    const resumeContext = (input.resume_context as string) || "";
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

    // Step 2: Set flag and message — agent loop will short-circuit
    _pendingRestart = true;
    _restartMessage = reason;

    return `__RESTART_PENDING__`;
  },
};
