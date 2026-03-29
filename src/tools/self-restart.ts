/**
 * self_restart tool — request a rebuild and restart.
 *
 * Writes a .restart-request.json file. A separate watcher process
 * picks it up, builds, and restarts the service. The bot stays running
 * until the watcher kills it — no process.exit, no lost messages.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ToolHandler } from "../types.js";

export interface RestartState {
  reason: string;
  resumeContext: string;
  chatId: string;
  timestamp: number;
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
      console.warn(`[self_restart] Resume already attempted (attempts=${state.attempts}), deleting stale state`);
      fs.unlinkSync(statePath);
      return null;
    }

    // Write back with incremented count — if we crash, next boot sees attempts=2
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    console.log(`[self_restart] Loaded restart state: ${state.reason} (attempt ${state.attempts})`);
    return state;
  } catch {
    return null;
  }
}

/** Clear restart state after successful resume */
export function clearRestartState(): void {
  try {
    fs.unlinkSync(getRestartStatePath());
    console.log("[self_restart] Restart state cleared (resume successful)");
  } catch {
    // Already gone
  }
}

export const selfRestartTool: ToolHandler = {
  definition: {
    name: "self_restart",
    description:
      "Request a rebuild and restart. A separate watcher process will build " +
      "the project and restart the service. The bot stays running until the " +
      "new build is ready. After restart, you'll receive the resume context " +
      "and can continue where you left off.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason for restart — sent to the user before shutdown",
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

    const requestPath = path.join(config.workspace, ".restart-request.json");

    // Check if a restart is already pending
    if (fs.existsSync(requestPath)) {
      return "A restart is already pending. Wait for it to complete.";
    }

    // Get current chat ID from the call context
    const { getCurrentChatId } = await import("./chat-context.js");
    const chatId = getCurrentChatId() || config.ownerChatId || "";

    // Write the request file — watcher picks it up
    const request = {
      reason,
      resumeContext,
      chatId,
      timestamp: Date.now(),
    };

    fs.writeFileSync(requestPath, JSON.stringify(request, null, 2), "utf-8");
    console.log(`[self_restart] Restart requested: ${reason}`);

    return `Restart requested. The watcher will build and restart the service. Reason: ${reason}`;
  },
};
