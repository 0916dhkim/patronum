/**
 * Stream usage test: verifies that OpenRouter streaming works correctly
 * both with and without usage data in the final SSE chunk.
 *
 * Finding 5: The `stream_options: { include_usage: true }` addition must
 * preserve normal streaming behavior if usage is absent. Some OpenRouter
 * providers may not honor `stream_options`, so we verify:
 *   1. When usage IS present: input_tokens are captured and emitted
 *   2. When usage is absent: stream still completes normally with 0 tokens
 *   3. Stream events (message_start, content_block_start, deltas, stops,
 *      message_delta, message_stop) are emitted in correct order regardless
 *
 * Run with: npx tsx src/tests/stream-usage.test.ts
 */

import { openrouterClient } from "../providers/openrouter.js";
import type { StreamEvent } from "../types.js";

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
// Fetch mock: SSE stream builder
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

/**
 * Build a mock Response that streams SSE chunks.
 * Each chunk is sent as a `data: {json}\n\n` SSE event.
 */
function mockSSEStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/**
 * Collect all events from the stream generator.
 */
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

section("Stream with usage data — input_tokens captured");
{
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12345,"completion_tokens":10,"total_tokens":12355}}\n\n',
    'data: [DONE]\n\n',
  ];

  globalThis.fetch = (() =>
    Promise.resolve(mockSSEStreamResponse(chunks))) as typeof fetch;

  const events = await collectEvents(
    openrouterClient.stream(
      [{ role: "user", content: "hi" }],
      "test/test-model",
      [{ type: "text", text: "You are a test assistant." }],
      [],
      { maxTokens: 100 }
    )
  );

  // Verify event sequence
  const types = events.map((e) => e.type);
  assert(types[0] === "message_start", "First event should be message_start");
  assert(types.includes("content_block_start"), "Should have content_block_start");
  assert(types.includes("content_block_delta"), "Should have content_block_delta");
  assert(types.includes("content_block_stop"), "Should have content_block_stop");
  assert(types.includes("message_delta"), "Should have message_delta");
  assert(types[types.length - 1] === "message_stop", "Last event should be message_stop");

  // Verify usage captured in message_delta
  const msgDelta = events.find((e) => e.type === "message_delta");
  assert(msgDelta !== undefined, "message_delta should exist");
  assert(
    (msgDelta as any).usage?.input_tokens === 12345,
    `input_tokens should be 12345, got ${(msgDelta as any).usage?.input_tokens}`
  );
  assert(
    (msgDelta as any).usage?.output_tokens === 10,
    `output_tokens should be 10, got ${(msgDelta as any).usage?.output_tokens}`
  );

  // Verify stop_reason
  assert(
    (msgDelta as any).delta?.stop_reason === "end_turn",
    "stop_reason should be end_turn"
  );
}
restoreFetch();

section("Stream WITHOUT usage data — normal behavior preserved");
{
  // Some providers may not send usage even with stream_options.include_usage.
  // The stream should still complete normally with 0 tokens.
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  globalThis.fetch = (() =>
    Promise.resolve(mockSSEStreamResponse(chunks))) as typeof fetch;

  const events = await collectEvents(
    openrouterClient.stream(
      [{ role: "user", content: "hi" }],
      "test/test-model",
      [{ type: "text", text: "You are a test assistant." }],
      [],
      { maxTokens: 100 }
    )
  );

  // Verify full event sequence still works
  const types = events.map((e) => e.type);
  assert(types[0] === "message_start", "First event should be message_start");
  assert(types.includes("content_block_start"), "Should have content_block_start");
  assert(types.includes("content_block_delta"), "Should have content_block_delta");
  assert(types.includes("content_block_stop"), "Should have content_block_stop");
  assert(types.includes("message_delta"), "Should have message_delta");
  assert(types[types.length - 1] === "message_stop", "Last event should be message_stop");

  // Verify usage defaults to 0 when absent
  const msgDelta = events.find((e) => e.type === "message_delta");
  assert(msgDelta !== undefined, "message_delta should exist");
  assert(
    (msgDelta as any).usage?.output_tokens === 0,
    `output_tokens should be 0 when absent, got ${(msgDelta as any).usage?.output_tokens}`
  );
  // input_tokens should NOT be present when usage is absent
  assert(
    (msgDelta as any).usage?.input_tokens === undefined,
    "input_tokens should be undefined when usage is absent"
  );

  // Verify text content was still streamed
  const deltas = events.filter((e) => e.type === "content_block_delta");
  const text = deltas.map((d) => (d as any).delta?.text || "").join("");
  assert(text === "Hello world", `Streamed text should be "Hello world", got "${text}"`);
}
restoreFetch();

section("Stream with tool calls but no usage — tool events preserved");
{
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec","arguments":"{\\"cmd\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  globalThis.fetch = (() =>
    Promise.resolve(mockSSEStreamResponse(chunks))) as typeof fetch;

  const events = await collectEvents(
    openrouterClient.stream(
      [{ role: "user", content: "run ls" }],
      "test/test-model",
      [{ type: "text", text: "You are a test assistant." }],
      [{ name: "exec", description: "Execute command", input_schema: { type: "object", properties: { cmd: { type: "string" } } } }],
      { maxTokens: 100 }
    )
  );

  const types = events.map((e) => e.type);
  assert(types.includes("content_block_start"), "Should have content_block_start for tool");
  assert(types.includes("content_block_delta"), "Should have content_block_delta for tool args");
  assert(types.includes("content_block_stop"), "Should have content_block_stop for tool");

  const msgDelta = events.find((e) => e.type === "message_delta");
  assert(
    (msgDelta as any).delta?.stop_reason === "tool_use",
    "stop_reason should be tool_use"
  );
}
restoreFetch();

section("Stream with usage in separate final chunk (empty choices) — captured");
{
  // OpenRouter sometimes sends usage in a final chunk with empty choices
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":2,"total_tokens":502}}\n\n',
    'data: [DONE]\n\n',
  ];

  globalThis.fetch = (() =>
    Promise.resolve(mockSSEStreamResponse(chunks))) as typeof fetch;

  const events = await collectEvents(
    openrouterClient.stream(
      [{ role: "user", content: "hi" }],
      "test/test-model",
      [{ type: "text", text: "You are a test assistant." }],
      [],
      { maxTokens: 100 }
    )
  );

  const msgDelta = events.find((e) => e.type === "message_delta");
  assert(
    (msgDelta as any).usage?.input_tokens === 500,
    `input_tokens should be 500 from final empty-choices chunk, got ${(msgDelta as any).usage?.input_tokens}`
  );
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
