import { runAgent, extractTextFromResponse, CLAUDE_CODE_IDENTITY } from "../agent.js";
import { executeTool, setCurrentChatId } from "../tools/index.js";
import { getAgentDef } from "../agents.js";
import { EvalTest } from "./loader.js";
import { createInterceptor, ToolCallEntry } from "./interceptor.js";
import { evaluateDeterministicAssertions, AssertionResult } from "./assertions.js";
import { gradeAssertions, GradeResult } from "./grader.js";
import type { Message } from "../types.js";

export interface TestResult {
  name: string;
  status: "PASS" | "FAIL" | "PARTIAL" | "ERROR";
  duration_ms: number;
  toolAssertions: AssertionResult[];
  gradedAssertions: GradeResult[];
  substringAssertions: AssertionResult[];
  toolCallLog: ToolCallEntry[];
  agentResponseText: string;
  error?: string;
}

export interface EvalRun {
  id: string;
  timestamp: string;
  tests: TestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    partial: number;
    error: number;
  };
}

const MAX_TOOL_ITERATIONS = 20;

/**
 * Run a single test in isolation.
 */
export async function runTest(test: EvalTest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Build message history
    const messages: Message[] = [];

    // Add conversation history if present
    if (test.input.history) {
      for (const entry of test.input.history) {
        messages.push({
          role: entry.role,
          content: entry.content,
        });
      }
    }

    // Build the user message, possibly with mock recall injection
    let userMessage = test.input.message;
    if (test.input.mock_recall) {
      userMessage = `${test.input.message}

<memory_context>
Automatically retrieved memory fragments that may be relevant to this message.
These are background reference only — do not respond to or reference them directly unless they are clearly relevant to what the user is asking. Many may be irrelevant noise.

${test.input.mock_recall}
</memory_context>`;
    }

    messages.push({
      role: "user",
      content: userMessage,
    });

    // Determine if this is a subagent test and get agent def if needed
    let agentDef = null;
    if (test.agent) {
      agentDef = getAgentDef(test.agent);
      if (!agentDef) {
        return {
          name: test.name,
          status: "ERROR",
          duration_ms: Date.now() - startTime,
          toolAssertions: [],
          gradedAssertions: [],
          substringAssertions: [],
          toolCallLog: [],
          agentResponseText: "(error)",
          error: `Agent not found: ${test.agent}`,
        };
      }
    }

    // Create interceptor (subagent mode if testing a subagent)
    const interceptor = createInterceptor(executeTool, { subagentMode: !!agentDef });

    // Set a fake chat ID for tools that need it
    setCurrentChatId("eval-test-" + test.name);

    // Run the agent with the intercepted executor
    let result;
    try {
      // Wrap the executor to track iterations
      let iterations = 0;
      const countingExecutor = async (
        name: string,
        input: Record<string, unknown>
      ) => {
        iterations++;
        if (iterations > MAX_TOOL_ITERATIONS) {
          throw new Error(
            `Tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations — stopping`
          );
        }
        return interceptor.executor(name, input);
      };

      // Build options for runAgent
      const agentOptions: Parameters<typeof runAgent>[1] = {
        toolExecutor: countingExecutor,
      };

      // If testing a subagent, inject its model and system prompt
      if (agentDef) {
        agentOptions.model = agentDef.model;
        agentOptions.systemPrompt = [
          { type: "text", text: CLAUDE_CODE_IDENTITY },
          { type: "text", text: agentDef.systemPrompt },
        ];
      }

      result = await runAgent(messages, agentOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("exceeded")) {
        return {
          name: test.name,
          status: "ERROR",
          duration_ms: Date.now() - startTime,
          toolAssertions: [],
          gradedAssertions: [],
          substringAssertions: [],
          toolCallLog: interceptor.getLog(),
          agentResponseText: "(error: tool loop exceeded maximum iterations)",
          error: msg,
        };
      }
      throw err;
    }

    // Extract response text
    const agentResponseText = extractTextFromResponse(result.messages);
    const toolCallLog = interceptor.getLog();

    // Evaluate deterministic assertions
    const deterministicResults = evaluateDeterministicAssertions(
      test,
      toolCallLog,
      agentResponseText
    );

    // Separate assertions by type
    const toolAssertions = deterministicResults.filter(
      (r) => r.type === "tool_called" || r.type === "tool_not_called"
    );
    const substringAssertions = deterministicResults.filter(
      (r) => r.type === "response_contains" || r.type === "response_not_contains"
    );

    // Grade qualitative assertions in parallel
    const gradedAssertions = test.assertions.graded
      ? await gradeAssertions(
          test.name,
          test.description || "",
          test.input.message,
          agentResponseText,
          toolCallLog,
          test.assertions.graded
        )
      : [];

    // Determine overall status
    // Check deterministic assertions
    const deterministicFailed = [...toolAssertions, ...substringAssertions].filter(
      (r) => !r.passed
    );
    // Check graded assertions
    const gradedFailed = gradedAssertions.filter((r) => r.verdict === "FAIL" || r.verdict === "ERROR");
    const gradedPartial = gradedAssertions.filter((r) => r.verdict === "PARTIAL");

    let status: "PASS" | "FAIL" | "PARTIAL" = "PASS";
    if (deterministicFailed.length > 0 || gradedFailed.length > 0) {
      status = "FAIL";
    } else if (gradedPartial.length > 0) {
      status = "PARTIAL";
    }

    return {
      name: test.name,
      status,
      duration_ms: Date.now() - startTime,
      toolAssertions,
      gradedAssertions,
      substringAssertions,
      toolCallLog,
      agentResponseText,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: test.name,
      status: "ERROR",
      duration_ms: Date.now() - startTime,
      toolAssertions: [],
      gradedAssertions: [],
      substringAssertions: [],
      toolCallLog: [],
      agentResponseText: "(error)",
      error: msg,
    };
  }
}

/**
 * Run all tests in parallel.
 */
export async function runAllTests(tests: EvalTest[]): Promise<EvalRun> {
  const startTime = new Date();
  const results = await Promise.all(tests.map(runTest));

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    partial: results.filter((r) => r.status === "PARTIAL").length,
    error: results.filter((r) => r.status === "ERROR").length,
  };

  return {
    id: startTime.getTime().toString(),
    timestamp: startTime.toISOString(),
    tests: results,
    summary,
  };
}
