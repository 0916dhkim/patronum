import { config } from "../config.js";
import { ToolCallEntry } from "./interceptor.js";

export interface GradeResult {
  assertion: string;
  verdict: "PASS" | "FAIL" | "PARTIAL" | "ERROR";
  reasoning: string;
}

/**
 * Call Haiku to evaluate a single qualitative assertion.
 * Direct API call with no tools or tool loop.
 */
export async function gradeAssertion(
  testName: string,
  testDescription: string,
  inputMessage: string,
  agentResponseText: string,
  toolCallsLog: ToolCallEntry[],
  assertion: string
): Promise<GradeResult> {
  // Format tool calls for the prompt
  const toolCallsText =
    toolCallsLog.length === 0
      ? "No tool calls made"
      : toolCallsLog.map((t) => `- ${t.name}: ${JSON.stringify(t.input)}`).join("\n");

  const prompt = `You are evaluating an AI agent's response against a specific criterion.

## Scenario
Name: ${testName}
${testDescription ? `Description: ${testDescription}` : ""}
Input message: ${inputMessage}

## Agent Output
Response text:
${agentResponseText}

Tools called:
${toolCallsText}

## Criterion
${assertion}

Does the agent's output satisfy this criterion? Reply with exactly one of:
PASS — if the criterion is clearly satisfied
FAIL — if the criterion is clearly not satisfied
PARTIAL — if it's ambiguous

Then on a new line, explain your reasoning in 1-2 sentences.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.claudeToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": "claude-cli/2.1.85",
        "x-app": "cli",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        assertion,
        verdict: "ERROR",
        reasoning: `Grader API error ${response.status}: ${body.slice(0, 100)}`,
      };
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    const text =
      data.content.find((b) => b.type === "text")?.text || "(no response)";

    // Parse the first line for the verdict
    const lines = text.split("\n").map((l) => l.trim());
    const firstLine = lines[0];

    let verdict: "PASS" | "FAIL" | "PARTIAL" | "ERROR" = "PARTIAL";
    if (firstLine.startsWith("PASS")) {
      verdict = "PASS";
    } else if (firstLine.startsWith("FAIL")) {
      verdict = "FAIL";
    } else if (firstLine.startsWith("PARTIAL")) {
      verdict = "PARTIAL";
    } else {
      // Try to find verdict in the text
      if (text.includes("PASS")) verdict = "PASS";
      else if (text.includes("FAIL")) verdict = "FAIL";
      // Default to PARTIAL if ambiguous
    }

    // Get reasoning (everything after the first line)
    const reasoning = lines.slice(1).join("\n").trim() || "(no reasoning provided)";

    return {
      assertion,
      verdict,
      reasoning,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      assertion,
      verdict: "ERROR",
      reasoning: `Grader error: ${msg}`,
    };
  }
}

/**
 * Grade all assertions for a test in parallel.
 */
export async function gradeAssertions(
  testName: string,
  testDescription: string,
  inputMessage: string,
  agentResponseText: string,
  toolCallsLog: ToolCallEntry[],
  assertions: string[]
): Promise<GradeResult[]> {
  return Promise.all(
    assertions.map((a) =>
      gradeAssertion(testName, testDescription, inputMessage, agentResponseText, toolCallsLog, a)
    )
  );
}
