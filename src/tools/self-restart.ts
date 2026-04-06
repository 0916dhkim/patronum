/**
 * self_restart tool — spawn restart.sh as a detached background process.
 * All restart state lives in the script's memory. If it crashes, nothing is stale.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ToolHandler } from "../types.js";

export interface RestartState {
  reason: string;
  resumeContext: string;
  chatId: string;
  attempts: number;
}

function getRestartStatePath(): string {
  return path.join(config.workspace, ".restart-state.json");
}

/** Load restart state on boot. Consume-once: bails if already attempted. */
export function loadRestartState(): RestartState | null {
  const statePath = getRestartStatePath();
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw) as RestartState;

    state.attempts = (state.attempts ?? 0) + 1;

    if (state.attempts > 1) {
      console.warn(`[self_restart] Resume already attempted, deleting stale state`);
      fs.unlinkSync(statePath);
      return null;
    }

    // Write back incremented — if resume crashes, next boot sees attempts=2
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    console.log(`[self_restart] Loaded restart state: ${state.reason}`);
    return state;
  } catch {
    return null;
  }
}

/** Clear restart state after successful resume */
export function clearRestartState(): void {
  try {
    fs.unlinkSync(getRestartStatePath());
    console.log("[self_restart] Restart state cleared");
  } catch {}
}

export const selfRestartTool: ToolHandler = {
  definition: {
    name: "self_restart",
    description:
      "Rebuild and restart the bot. Spawns a background script that builds, " +
      "then restarts the service. The bot stays running during the build. " +
      "After restart, you receive your resume_context to continue.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason for restart — shown to the user",
        },
        resume_context: {
          type: "string",
          description:
            "State description for yourself after restart — describe what was in progress and why the restart was triggered. " +
            "This is a state snapshot, not a to-do list. On restart, you'll assess current state before deciding what to do. " +
            "You lose all in-flight state on restart, so capture key context here.",
        },
      },
      required: ["reason"],
    },
  },

  terminatesLoop: true,

  async execute(input: Record<string, unknown>): Promise<string> {
    const reason = (input.reason as string) || "no reason given";
    const resumeContext = (input.resume_context as string) || "";

    const { getCurrentChatId } = await import("./chat-context.js");
    const chatId = getCurrentChatId() || config.ownerChatId || "";

    // Refuse to restart if there are running tasks in any chat — a restart kills the whole process
    const { taskManager } = await import("../task-manager.js");
    const runningTasks = taskManager.getAllRunning();
    if (runningTasks.length > 0) {
      const taskList = runningTasks
        .map((t) => `  • ${t.taskId} — ${t.agent} (${Math.round((Date.now() - t.startedAt) / 1000)}s)`)
        .join("\n");
      throw new Error(`Cannot restart — ${runningTasks.length} task(s) still running:\n${taskList}\n\nCancel them first or wait for them to finish.`);
    }

    const sourceDir = path.join(config.workspace, "source");
    const scriptPath = path.join(sourceDir, "scripts", "restart.sh");

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Restart script not found at ${scriptPath}`);
    }

    // Spawn detached — script owns its own lifecycle
    const child = spawn("bash", [scriptPath, sourceDir, config.workspace, reason, resumeContext, chatId], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    console.log(`[self_restart] Spawned restart.sh (PID ${child.pid}): ${reason}`);

    return `Restart initiated. Building in background — I'll be back shortly. Reason: ${reason}`;
  },
};
