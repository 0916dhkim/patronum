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
      },
      required: ["test"],
    },
  },

  async execute(input): Promise<string> {
    const testName = input.test as string;
    const subagentMd = input.subagent_md as string | undefined;

    const args = ["run", testName];
    if (subagentMd) {
      args.push("--subagent-md", subagentMd);
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = spawn("node", ["/var/lib/patronum/source/dist/eval.js", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Set up a timeout
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, TIMEOUT_MS);

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timeoutHandle);

        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        if (timedOut) {
          parts.push("[killed: timeout (5 minutes)]");
        } else if (code !== 0) {
          parts.push(`[exit code: ${code}]`);
        }

        resolve(parts.join("\n") || "(no output)");
      });

      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        resolve(`[spawn error] ${err.message}`);
      });
    });
  },
};
