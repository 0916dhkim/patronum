import { extractTextFromResponse, CLAUDE_CODE_IDENTITY, buildSystemPrompt } from "../agent.js";
import { setCurrentChatId, getToolDefinitions, setSkillOverrides } from "../tools/index.js";
import { getAgentDef } from "../agents.js";
import { buildSkillsSummary, buildSkillBodies } from "../skills.js";
import { EvalTest } from "./loader.js";
import type { ToolCallEntry } from "./interceptor.js";
import { evaluateDeterministicAssertions, AssertionResult } from "./assertions.js";
import { gradeAssertions, GradeResult } from "./grader.js";
import { config } from "../config.js";
import { prepareMessagesForClaude, prepareSystemPromptForClaude, logUsage, getTotalInputTokens } from "../prompt-cache.js";
import type { Message, ToolUseBlock, ClaudeResponse, ContentBlock } from "../types.js";
import type { PromptOverrides } from "../eval.js";

export interface TestResult {
  name: string;
  comments?: string;
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

/**
 * Make a single Claude API call without looping (for single-call eval mode).
 */
async function makeSingleClaudeCall(
  messages: Message[],
  model: string,
  systemPrompt: Array<{ type: "text"; text: string }>
): Promise<{ content: ContentBlock[]; inputTokens: number }> {
  const API_URL = "https://api.anthropic.com/v1/messages";
  const MAX_TOKENS = 8192;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.claudeToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/2.1.85",
      "x-app": "cli",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: prepareSystemPromptForClaude(systemPrompt),
      tools: getToolDefinitions(),
      messages: prepareMessagesForClaude(messages),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as ClaudeResponse;
  logUsage("lin", data.usage);
  
  const inputTokens = getTotalInputTokens(data.usage);
  return { content: data.content, inputTokens };
}

/**
 * Run a single test in isolation.
 * 
 * Single-call mode only: Make one API call, record tool_use blocks, do not execute tools.
 */
export async function runTest(test: EvalTest, overrides?: PromptOverrides): Promise<TestResult> {
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

    // Build the user message, possibly with mock recall injection.
    // If message is absent, the history must end with a user turn (e.g. a tool_result)
    // and we run the eval without appending anything further.
    if (test.input.message !== undefined) {
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
    }

    // Determine if this is a subagent test and get agent def if needed
    let agentDef = null;
    if (test.agent) {
      agentDef = getAgentDef(test.agent);
      if (!agentDef) {
        return {
          name: test.name,
          comments: test.comments,
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

    // Validate override constraints
    if (overrides?.subagentMdPath && !test.agent) {
      return {
        name: test.name,
        comments: test.comments,
        status: "ERROR",
        duration_ms: Date.now() - startTime,
        toolAssertions: [],
        gradedAssertions: [],
        substringAssertions: [],
        toolCallLog: [],
        agentResponseText: "(error)",
        error: `--subagent-md can only be used with subagent tests (tests with 'agent:' field)`,
      };
    }

    // Set a fake chat ID for tools that need it
    setCurrentChatId("eval-test-" + test.name);

    // Set skill overrides if present (for multi-call mode or future use)
    setSkillOverrides(
      overrides?.skillContent && typeof overrides.skillContent === "object"
        ? (overrides.skillContent as Record<string, string>)
        : undefined
    );

    // Single-call mode: Make ONE Claude API call, extract tool calls, don't execute them.
    // No tool loop, no tool result messages sent back to Claude.
    
    const model = agentDef?.model || config.claudeModel;

    let systemPrompt: Array<{ type: "text"; text: string }>;
    if (agentDef) {
      // For subagents, use their system prompt
      let subagentSystemPrompt = agentDef.systemPrompt;

      // Apply --subagent-md override if present
      if (overrides?.subagentContent !== undefined) {
        subagentSystemPrompt = overrides.subagentContent;
      }

      const blocks: Array<{ type: "text"; text: string }> = [];
      blocks.push({ type: "text", text: CLAUDE_CODE_IDENTITY });
      blocks.push({ type: "text", text: subagentSystemPrompt });

      // For eval (single-call mode), keep skill bodies in subagent prompts.
      // Tools don't execute in eval, so progressive disclosure via load_skill won't work.
      // This preserves backward compatibility with existing subagent tests.
      const skillBodies = buildSkillBodies(
        overrides?.skillContent && typeof overrides.skillContent === "object"
          ? (overrides.skillContent as Record<string, string>)
          : undefined
      );
      if (skillBodies) {
        blocks.push({ type: "text", text: skillBodies });
      }

      systemPrompt = blocks.filter((block) => block.text.trim().length > 0);
    } else {
      // For main agent (Lin), build full system prompt with overrides
      systemPrompt = buildSystemPrompt({
        soulContent: overrides?.soulContent,
        agentsContent: overrides?.agentsContent,
        skillOverrides: overrides?.skillContent,
      });
    }

    const { content, inputTokens } = await makeSingleClaudeCall(messages, model, systemPrompt);

    // Extract tool_use blocks from the response
    const toolUseBlocks = content.filter((block): block is ToolUseBlock => block.type === "tool_use");

    const toolCallLog = toolUseBlocks.map((block) => ({
      name: block.name,
      input: block.input,
      timestamp: Date.now(),
      result: "(tool not executed in single-call mode)",
    }));

    // Build a result object with the response message
    const assistantMessage: Message = {
      role: "assistant",
      content,
    };

    const result = {
      messages: [assistantMessage],
      inputTokens,
    };

    // Extract response text
    const agentResponseText = extractTextFromResponse(result.messages);

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
          test.input.message ?? "(no message — history-only test)",
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
      comments: test.comments,
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
      comments: test.comments,
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
export async function runAllTests(tests: EvalTest[], overrides?: PromptOverrides): Promise<EvalRun> {
  const startTime = new Date();
  const results = await Promise.all(tests.map((test) => runTest(test, overrides)));

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
