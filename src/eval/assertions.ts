import { EvalTest, EvalTestAssertions } from "./loader.js";
import { ToolCallEntry } from "./interceptor.js";

export interface AssertionResult {
  assertion: string;
  passed: boolean;
  type: "tool_called" | "tool_not_called" | "response_contains" | "response_not_contains";
}

/**
 * Evaluate deterministic assertions (tool calls and substring matches).
 * Qualitative assertions (graded) are handled separately by the grader.
 */
export function evaluateDeterministicAssertions(
  test: EvalTest,
  toolLog: ToolCallEntry[],
  responseText: string
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const assertions = test.assertions;

  // Get set of tools that were called
  const calledToolNames = new Set(toolLog.map((entry) => entry.name));

  // tools_called: each tool must appear in the log
  if (assertions.tools_called) {
    for (const tool of assertions.tools_called) {
      results.push({
        assertion: `tools_called: ${tool}`,
        passed: calledToolNames.has(tool),
        type: "tool_called",
      });
    }
  }

  // tools_not_called: each tool must NOT appear in the log
  if (assertions.tools_not_called) {
    for (const tool of assertions.tools_not_called) {
      results.push({
        assertion: `tools_not_called: ${tool}`,
        passed: !calledToolNames.has(tool),
        type: "tool_not_called",
      });
    }
  }

  // response_contains: substring must appear (case-insensitive)
  if (assertions.response_contains) {
    const responseLower = responseText.toLowerCase();
    for (const substring of assertions.response_contains) {
      const found = responseLower.includes(substring.toLowerCase());
      results.push({
        assertion: `response_contains: "${substring}"`,
        passed: found,
        type: "response_contains",
      });
    }
  }

  // response_not_contains: substring must NOT appear (case-insensitive)
  if (assertions.response_not_contains) {
    const responseLower = responseText.toLowerCase();
    for (const substring of assertions.response_not_contains) {
      const found = responseLower.includes(substring.toLowerCase());
      results.push({
        assertion: `response_not_contains: "${substring}"`,
        passed: !found,
        type: "response_not_contains",
      });
    }
  }

  return results;
}
