import { spawn } from "child_process";
import type { ToolHandler } from "../types.js";

const TIMEOUT_MS = 300_000; // 5 minutes

export const runEvalTool: ToolHandler = {
  definition: {
    name: "run_eval",
    description:
      "Runs an eval test by name and returns the results. Has a 5-minute timeout for LLM-based tests.",
    input_schema: {
      type: "object",
      properties: {
        test: {
          type: "string",
          description: "Eval test name to run (e.g. 'alex-output-not-overspecified')",
        },
        subagent_md: {
          type: "string",
          description: "Optional path to override the agent's SUBAGENT.md (for ablation runs)",
        },
        agents_md: {
          type: "string",
          description: "Optional path to override the agents file (for ablation runs)",
        },
        skill_md: {
          type: "string",
          description: "Optional skill overrides in format 'skillName=path' (e.g. 'patronum-behavior-test=/tmp/override.md')",
        },
      },
      required: ["test"],
    },
  },

  async execute(input): Promise<string> {
    const testName = input.test as string;
    const subagentMd = input.subagent_md as string | undefined;
    const agentsMd = input.agents_md as string | undefined;
    const skillMd = input.skill_md as string | undefined;

    const args = ["run", testName];
    if (subagentMd) {
      args.push("--subagent-md", subagentMd);
    }
    if (agentsMd) {
      args.push("--agents-md", agentsMd);
    }
    if (skillMd) {
      args.push("--skill-md", skillMd);
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child = spawn("node", ["/var/lib/patronum/source/dist/eval.js", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Track all timers so we can clear them on exit
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let sigkillEscalationHandle: ReturnType<typeof setTimeout> | null = null;
      let forceResolveHandle: ReturnType<typeof setTimeout> | null = null;

      const clearAllTimers = () => {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (sigkillEscalationHandle !== null) clearTimeout(sigkillEscalationHandle);
        if (forceResolveHandle !== null) clearTimeout(forceResolveHandle);
      };

      const doResolve = (output: string) => {
        if (settled) return;
        settled = true;
        clearAllTimers();
        resolve(output);
      };

      // Set up initial timeout (SIGTERM phase)
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");

        // Start escalation timer: if process doesn't close in 5s, send SIGKILL
        sigkillEscalationHandle = setTimeout(() => {
          child.kill("SIGKILL");

          // Start force-resolve timer: if process STILL doesn't close in 5s, force-resolve
          forceResolveHandle = setTimeout(() => {
            const parts: string[] = [];
            if (stdout) parts.push(stdout);
            if (stderr) parts.push(`[stderr]\n${stderr}`);
            parts.push("[killed: process could not be terminated (timeout escalation failed)]");
            doResolve(parts.join("\n") || "(no output)");
          }, 5000);
        }, 5000);
      }, TIMEOUT_MS);

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        if (timedOut) {
          parts.push("[killed: timeout (5 minutes)]");
        } else if (code !== 0) {
          parts.push(`[exit code: ${code}]`);
        }

        doResolve(parts.join("\n") || "(no output)");
      });

      child.on("error", (err) => {
        doResolve(`[spawn error] ${err.message}`);
      });
    });
  },
};
