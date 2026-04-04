import { exec as cpExec } from "child_process";
import type { ToolHandler } from "../types.js";
import { config } from "../config.js";

const TIMEOUT_MS = 30_000;

export const execTool: ToolHandler = {
  definition: {
    name: "exec",
    description:
      "Execute a shell command and return stdout/stderr. Commands run in the workspace directory with a 30-second timeout.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute",
        },
      },
      required: ["command"],
    },
  },

  async execute(input): Promise<string> {
    const command = input.command as string;

    // Blocklist patterns to prevent bypassing self_restart
    const blocklist: RegExp[] = [
      /\bsystemctl\s+(stop|start|restart|reload|kill)\s+.*\bpatronum\b/i,
      /\bservice\s+patronum\s+(stop|start|restart)\b/i,
      /\bpkill\s+.*\b(node|patronum)\b/i,
    ];

    // Check if command matches any blocklist pattern
    for (const pattern of blocklist) {
      if (pattern.test(command)) {
        return `Blocked: "${command}" would affect the Patronum process directly. Use the self_restart tool to rebuild and restart safely.`;
      }
    }

    return new Promise((resolve) => {
      cpExec(
        command,
        { cwd: config.workspace, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const parts: string[] = [];
          if (stdout) parts.push(stdout);
          if (stderr) parts.push(`[stderr]\n${stderr}`);
          if (error && error.killed) parts.push("[killed: timeout]");
          else if (error) parts.push(`[exit code: ${error.code}]`);
          resolve(parts.join("\n") || "(no output)");
        }
      );
    });
  },
};
