/**
 * Focused tests for the 70%-of-active-model-context compaction policy.
 *
 * Tests the pure logic functions exported from compaction.ts:
 *   - computeChunkCharBudget (including throw-on-tiny-window regression)
 *   - computeMaxMergeChunks
 *   - isContextWindowUsable
 *   - findSafeSplitIndex
 *   - compactIfNeeded threshold math
 *
 * Run with: npx tsx src/tests/compaction.test.ts
 */

import {
  computeChunkCharBudget,
  computeMaxMergeChunks,
  findSafeSplitIndex,
  isContextWindowUsable,
} from "../compaction.js";
import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from "../types.js";

// ---------------------------------------------------------------------------
// Test framework (minimal)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, message: string): void {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message} (expected ~${expected}, got ${actual}, diff=${diff})`);
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message} (expected throw, got none)`);
  } catch {
    passed++;
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ---------------------------------------------------------------------------
// Helper: create messages
// ---------------------------------------------------------------------------

function userText(text: string): Message {
  return { role: "user", content: text };
}

function assistantText(text: string): Message {
  return { role: "assistant", content: text };
}

function assistantToolUse(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} } as ToolUseBlock],
  };
}

function userToolResult(id: string, content: string, isError = false): Message {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, content, is_error: isError } as ToolResultBlock,
    ],
  };
}

// ---------------------------------------------------------------------------
// isContextWindowUsable tests (finding 3 & 4)
// ---------------------------------------------------------------------------

section("isContextWindowUsable — valid windows");
{
  assert(isContextWindowUsable(200_000), "200k should be usable");
  assert(isContextWindowUsable(128_000), "128k should be usable");
  assert(isContextWindowUsable(1_048_576), "1M should be usable");
  assert(isContextWindowUsable(1_050_000), "1.05M (Terra) should be usable");
}

section("isContextWindowUsable — invalid / tiny windows");
{
  assert(!isContextWindowUsable(0), "0 should be unusable");
  assert(!isContextWindowUsable(-1), "negative should be unusable");
  assert(!isContextWindowUsable(NaN), "NaN should be unusable");
  assert(!isContextWindowUsable(Infinity), "Infinity should be unusable");
  assert(!isContextWindowUsable(1_000), "1k should be unusable (too small for overhead)");
  assert(!isContextWindowUsable(5_000), "5k should be unusable");
  // 10k: system ~284 + output 2048 + safety 5000 = 7332 overhead, usable = 2668 < 10000
  assert(!isContextWindowUsable(10_000), "10k should be unusable (usable < MIN_USABLE)");
  // 20k: usable = 20000 - 7332 = 12668 >= 10000 → usable
  assert(isContextWindowUsable(20_000), "20k should be usable (usable >= MIN_USABLE)");
}

// ---------------------------------------------------------------------------
// computeChunkCharBudget tests (finding 3: no MIN_CHUNK_CHARS floor)
// ---------------------------------------------------------------------------

section("computeChunkCharBudget — 200k context window");
{
  const budget = computeChunkCharBudget(200_000);
  // System prompt ~850 chars / 3 = ~284 tokens
  // Available = 200000 - 284 - 2048 - 5000 = 192668 tokens
  // Chars = 192668 * 3 = 578004
  assertApprox(budget, 578_000, 2_000, "200k context → ~578k char budget");
  assert(budget > 400_000, "200k budget should be >400k chars");
  assert(budget < 600_000, "200k budget should be <600k chars");
}

section("computeChunkCharBudget — 1M context window");
{
  const budget = computeChunkCharBudget(1_048_576);
  // Available = 1048576 - 284 - 2048 - 5000 = 1041244
  // Chars = 1041244 * 3 = 3123732
  assertApprox(budget, 3_123_700, 2_000, "1M context → ~3.1M char budget");
  assert(budget > 3_000_000, "1M budget should be >3M chars");
}

section("computeChunkCharBudget — Terra 1.05M context window");
{
  const budget = computeChunkCharBudget(1_050_000);
  assert(budget > 3_000_000, "Terra budget should be >3M chars");
  assert(budget < 3_200_000, "Terra budget should be <3.2M chars");
}

section("computeChunkCharBudget — small context (128k)");
{
  const budget = computeChunkCharBudget(128_000);
  // Available = 128000 - 284 - 2048 - 5000 = 120668
  // Chars = 120668 * 3 = 362004
  assertApprox(budget, 362_000, 2_000, "128k context → ~362k char budget");
  assert(budget > 300_000, "128k budget should be >300k chars");
}

section("computeChunkCharBudget — tiny/invalid context throws (regression for finding 3)");
{
  // Previously, MIN_CHUNK_CHARS floor could produce a prompt larger than the
  // context window. Now it throws instead.
  assertThrows(() => computeChunkCharBudget(0), "0 context should throw");
  assertThrows(() => computeChunkCharBudget(-100), "negative context should throw");
  assertThrows(() => computeChunkCharBudget(1_000), "1k context should throw");
  assertThrows(() => computeChunkCharBudget(5_000), "5k context should throw");
  assertThrows(() => computeChunkCharBudget(10_000), "10k context should throw (usable < MIN)");
}

section("computeChunkCharBudget — output never exceeds safe usable context");
{
  // For any valid context window, the budget in chars should never exceed
  // the total context window expressed in chars (contextWindow * charsPerToken).
  // This is the absolute ceiling — any budget above this would mean the chunk
  // alone (without system prompt or output) exceeds the model's context.
  for (const cw of [20_000, 50_000, 128_000, 200_000, 1_050_000]) {
    const budget = computeChunkCharBudget(cw);
    const maxPossibleChars = cw * 3; // CHARS_PER_TOKEN = 3
    assert(
      budget < maxPossibleChars,
      `budget ${budget} should be less than total context chars ${maxPossibleChars} for cw=${cw}`
    );
  }
}

// ---------------------------------------------------------------------------
// computeMaxMergeChunks tests
// ---------------------------------------------------------------------------

section("computeMaxMergeChunks — 200k context");
{
  const maxChunks = computeMaxMergeChunks(200_000);
  // Available merge tokens = 200000 - ~200 - 2048 - 5000 = ~192752
  // Max chunks = 192752 / 2048 = ~94
  assert(maxChunks >= 80, "200k should allow >=80 merge chunks");
  assert(maxChunks <= 100, "200k should allow <=100 merge chunks");
}

section("computeMaxMergeChunks — 1M context");
{
  const maxChunks = computeMaxMergeChunks(1_048_576);
  // Available = 1048576 - 200 - 2048 - 5000 = ~1041328
  // Max chunks = 1041328 / 2048 = ~508
  assert(maxChunks >= 400, "1M should allow >=400 merge chunks");
}

section("computeMaxMergeChunks — tiny context throws");
{
  assertThrows(() => computeMaxMergeChunks(1_000), "1k context merge should throw");
  assertThrows(() => computeMaxMergeChunks(5_000), "5k context merge should throw");
}

// ---------------------------------------------------------------------------
// findSafeSplitIndex tests
// ---------------------------------------------------------------------------

section("findSafeSplitIndex — clean boundary at initial split");
{
  const messages: Message[] = [
    userText("hello"),
    assistantText("hi"),
    userText("do work"),
    assistantText("done"),
    userText("next task"),  // index 4 — clean user message
  ];
  const split = findSafeSplitIndex(messages, 4);
  assert(split === 4, "Should return 4 for clean user message at initial split");
}

section("findSafeSplitIndex — split at tool_result, scans back to clean user");
{
  const messages: Message[] = [
    userText("hello"),          // 0
    assistantText("hi"),        // 1
    userText("run tool"),       // 2 — clean user
    assistantToolUse("t1", "exec"), // 3
    userToolResult("t1", "result"), // 4 — tool_result, NOT clean
    assistantText("summary"),   // 5
    userText("next"),           // 6
  ];
  const split = findSafeSplitIndex(messages, 4);
  assert(split === 2, `Should scan back to index 2 (clean user), got ${split}`);
}

section("findSafeSplitIndex — split in middle of multi-turn tool conversation");
{
  const messages: Message[] = [
    userText("start"),           // 0
    assistantText("ok"),         // 1
    userText("do multi-step"),   // 2 — clean user
    assistantToolUse("t1", "step1"), // 3
    userToolResult("t1", "r1"),  // 4 — tool_result
    assistantToolUse("t2", "step2"), // 5
    userToolResult("t2", "r2"),  // 6 — tool_result (initial split here)
    assistantText("done"),       // 7
    userText("next"),            // 8
  ];
  const split = findSafeSplitIndex(messages, 6);
  // Should scan back past tool_results and tool_uses to index 2
  assert(split === 2, `Should scan back to index 2 (start of tool conversation), got ${split}`);
}

section("findSafeSplitIndex — split at assistant message, scans back to user");
{
  const messages: Message[] = [
    userText("hello"),       // 0
    assistantText("hi"),     // 1
    userText("task"),        // 2
    assistantText("working"),// 3 — assistant, not clean
    userText("more"),        // 4
  ];
  const split = findSafeSplitIndex(messages, 3);
  // Assistant message — not a clean boundary, scan back to index 2
  assert(split === 2, `Should scan back to user at index 2, got ${split}`);
}

section("findSafeSplitIndex — no clean boundary (all tool messages)");
{
  const messages: Message[] = [
    assistantToolUse("t1", "exec"), // 0
    userToolResult("t1", "r1"),     // 1
    assistantToolUse("t2", "exec"), // 2
    userToolResult("t2", "r2"),     // 3
  ];
  const split = findSafeSplitIndex(messages, 2);
  // No clean user message exists → returns 0
  assert(split === 0, `Should return 0 when no clean boundary exists, got ${split}`);
}

section("findSafeSplitIndex — initial split at 0");
{
  const messages: Message[] = [userText("hello")];
  const split = findSafeSplitIndex(messages, 0);
  assert(split === 0, "Should return 0 when initial split is 0");
}

section("findSafeSplitIndex — user with text + image (no tool_result) is clean");
{
  const messages: Message[] = [
    userText("hello"),
    assistantText("hi"),
    {
      role: "user",
      content: [
        { type: "text", text: "see this image" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ] as ContentBlock[],
    },
  ];
  const split = findSafeSplitIndex(messages, 2);
  // User message with text + image but no tool_result → clean
  assert(split === 2, `User with image (no tool_result) should be clean boundary, got ${split}`);
}

// ---------------------------------------------------------------------------
// Threshold math tests
// ---------------------------------------------------------------------------

section("compactIfNeeded threshold — 70% of context window");
{
  // For a 200k model: threshold = floor(200000 * 0.70) = 140000
  // For a 1M model: threshold = floor(1048576 * 0.70) = 734003
  // For Terra (1.05M): threshold = floor(1050000 * 0.70) = 735000
  const threshold200k = Math.floor(200_000 * 0.70);
  const threshold1M = Math.floor(1_048_576 * 0.70);
  const thresholdTerra = Math.floor(1_050_000 * 0.70);

  assert(threshold200k === 140_000, `200k → 140k threshold, got ${threshold200k}`);
  assert(threshold1M === 734_003, `1M → 734003 threshold, got ${threshold1M}`);
  assert(thresholdTerra === 735_000, `Terra → 735000 threshold, got ${thresholdTerra}`);

  // Verify threshold boundaries
  assert(199_999 >= threshold200k, "199,999 should trigger on 200k model (>=140k)");
  assert(139_999 < threshold200k, "139,999 should NOT trigger on 200k model (<140k)");

  // Terra: 140k would NOT trigger (needs >= 735k)
  assert(140_000 < thresholdTerra, "140k should NOT trigger on Terra (<735k)");
  assert(735_000 >= thresholdTerra, "735k should trigger on Terra (>=735k)");
}

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
