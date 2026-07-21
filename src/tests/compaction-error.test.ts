/**
 * Integration test: compactIfNeeded error-handling contract.
 *
 * Verifies that compactIfNeeded:
 *   1. Preserves original history when summarization fails (empty response)
 *   2. Preserves original history when the LLM call throws
 *   3. Does NOT trigger compaction below the 70% threshold
 *   4. Does trigger compaction above the 70% threshold
 *
 * Uses global fetch mocking to intercept LLM calls without network access.
 *
 * Run with: npx tsx src/tests/compaction-error.test.ts
 */

import { compactIfNeeded } from "../compaction.js";
import type { Message, ToolUseBlock, ToolResultBlock } from "../types.js";

// ---------------------------------------------------------------------------
// Test framework
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "user", content: `User message ${i}` });
    messages.push({ role: "assistant", content: `Assistant response ${i}` });
  }
  return messages;
}

// The model string determines the provider: "test/model" → OpenRouter
// OpenRouter's getContextWindow uses a lookup table, defaulting to 200k.
const TEST_MODEL = "test/test-model";
// 200k * 0.70 = 140k threshold

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(responses: {
  // Map URL pattern → response factory
  openrouter?: (body: any) => Response;
}): void {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("openrouter.ai")) {
      const body = JSON.parse(init?.body as string);
      const factory = responses.openrouter;
      if (factory) {
        return Promise.resolve(factory(body));
      }
    }

    // Default: return empty 200
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [] }), { status: 200 })
    );
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

section("Below threshold — no compaction");
{
  const messages = makeMessages(50);
  const result = await compactIfNeeded(messages, 50_000, TEST_MODEL); // 50k < 140k threshold
  assert(!result.compacted, "Should not compact below 70% threshold");
  assert(result.messages === messages, "Should return original messages reference");
}
restoreFetch();

section("Above threshold but LLM returns empty text — preserve history");
{
  const messages = makeMessages(50);
  // 150k > 140k threshold → triggers compaction
  // Mock OpenRouter to return a response with empty text content
  mockFetch({
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",  // Empty content!
                tool_calls: null,
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const result = await compactIfNeeded(messages, 150_000, TEST_MODEL);
  assert(!result.compacted, "Should NOT compact when summary is empty");
  assert(result.messages === messages, "Should return original messages reference on empty summary");
}
restoreFetch();

section("Above threshold but LLM returns null content — preserve history");
{
  const messages = makeMessages(50);
  mockFetch({
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,  // Null content!
                tool_calls: null,
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const result = await compactIfNeeded(messages, 150_000, TEST_MODEL);
  assert(!result.compacted, "Should NOT compact when summary is null");
  assert(result.messages === messages, "Should return original messages on null content");
}
restoreFetch();

section("Above threshold but fetch throws — preserve history");
{
  const messages = makeMessages(50);
  mockFetch({
    openrouter: (_body: any) => {
      throw new Error("Network error: connection refused");
    },
  });

  const result = await compactIfNeeded(messages, 150_000, TEST_MODEL);
  assert(!result.compacted, "Should NOT compact when LLM call throws");
  assert(result.messages === messages, "Should return original messages on network error");
}
restoreFetch();

section("Above threshold but API returns error — preserve history");
{
  const messages = makeMessages(50);
  mockFetch({
    openrouter: (_body: any) => {
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  const result = await compactIfNeeded(messages, 150_000, TEST_MODEL);
  assert(!result.compacted, "Should NOT compact when API returns 500");
  assert(result.messages === messages, "Should return original messages on API error");
}
restoreFetch();

section("Above threshold with valid summary — compaction succeeds");
{
  const messages = makeMessages(50);
  mockFetch({
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "## Current Objective\nTest summary\n\n## Important Context\n- Item 1",
                tool_calls: null,
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const result = await compactIfNeeded(messages, 150_000, TEST_MODEL);
  assert(result.compacted, "Should compact when summary is valid");
  assert(result.messages !== messages, "Should return new messages array on success");
  assert(result.messages.length < messages.length, "Compacted messages should be shorter");
  // Verify summary structure: [summaryMsg, ack, ...toKeep]
  assert(result.messages[0].role === "user", "First message should be user (summary)");
  assert(result.messages[1].role === "assistant", "Second message should be assistant (ack)");
}
restoreFetch();

section("Tool-result boundary preservation — toKeep doesn't start with tool_result");
{
  // Build messages with a tool conversation near the split point
  const messages: Message[] = [];
  for (let i = 0; i < 15; i++) {
    messages.push({ role: "user", content: `User ${i}` });
    messages.push({ role: "assistant", content: `Assistant ${i}` });
  }
  // Add a tool conversation right where the split would be
  messages.push({ role: "user", content: "Run tool please" });  // clean user
  messages.push({
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "exec", input: {} } as ToolUseBlock],
  });
  messages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "result" } as ToolResultBlock],
  });
  messages.push({ role: "assistant", content: "Done with tool" });
  messages.push({ role: "user", content: "Next task" });

  mockFetch({
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "## Current Objective\nSummary",
                tool_calls: null,
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const result = await compactIfNeeded(messages, 150_000, TEST_MODEL);
  assert(result.compacted, "Should compact");

  // Find where toKeep starts (after summary + ack)
  const toKeep = result.messages.slice(2); // skip summary + ack

  // toKeep[0] should NOT be a tool_result message
  const firstKeep = toKeep[0];
  const isToolResult =
    firstKeep.role === "user" &&
    Array.isArray(firstKeep.content) &&
    firstKeep.content.some((b) => b.type === "tool_result");
  assert(!isToolResult, "toKeep[0] should NOT be a tool_result message");

  // toKeep[0] should be a user message (clean conversation start)
  assert(firstKeep.role === "user", "toKeep[0] should be a user message");
}
restoreFetch();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log(`All tests passed! ✅`);
  process.exit(0);
}
