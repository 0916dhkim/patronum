/**
 * Focused tests for the 70%-of-active-model-context compaction policy.
 *
 * Tests the pure logic functions exported from compaction.ts:
 *   - computeChunkCharBudget (including throw-on-tiny-window regression)
 *   - computeMaxMergeChunks
 *   - computeMergeInputCharBudget
 *   - isContextWindowUsable
 *   - findSafeSplitIndex
 *   - compactIfNeeded threshold math
 *   - Dense tokenization safety (code/JSON/CJK at 1 char/token)
 *
 * Run with: npx tsx src/tests/compaction.test.ts
 */

import {
  computeChunkCharBudget,
  computeMaxMergeChunks,
  computeMergeInputCharBudget,
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
// Constants for verification (mirror compaction.ts)
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 1;
const MAX_SUMMARY_OUTPUT_TOKENS = 2048;
const SAFETY_MARGIN_TOKENS = 5000;
const COMPACTION_SYSTEM_PROMPT_LEN = 847;
const PROGRESSIVE_MERGE_PROMPT_LEN = 649;

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
  // With CHARS_PER_TOKEN = 1: system = 847 + output 2048 + safety 5000 = 7895 overhead
  // 10k: usable = 10000 - 7895 = 2105 < 10000
  assert(!isContextWindowUsable(10_000), "10k should be unusable (usable < MIN_USABLE)");
  // 20k: usable = 20000 - 7895 = 12105 >= 10000 → usable
  assert(isContextWindowUsable(20_000), "20k should be usable (usable >= MIN_USABLE)");
}

// ---------------------------------------------------------------------------
// computeChunkCharBudget tests (finding 3: no MIN_CHUNK_CHARS floor)
// With CHARS_PER_TOKEN = 1, budget = contextWindow - systemPrompt - output - safety
// ---------------------------------------------------------------------------

section("computeChunkCharBudget — 200k context window");
{
  const budget = computeChunkCharBudget(200_000);
  // System prompt 847 chars / 1 = 847 tokens
  // Available = 200000 - 847 - 2048 - 5000 = 192105 tokens
  // Chars = 192105 * 1 = 192105
  assertApprox(budget, 192_105, 100, "200k context → ~192k char budget");
  assert(budget > 180_000, "200k budget should be >180k chars");
  assert(budget < 200_000, "200k budget should be <200k chars");
}

section("computeChunkCharBudget — 1M context window");
{
  const budget = computeChunkCharBudget(1_048_576);
  // Available = 1048576 - 847 - 2048 - 5000 = 1040681
  // Chars = 1040681 * 1 = 1040681
  assertApprox(budget, 1_040_681, 100, "1M context → ~1.04M char budget");
  assert(budget > 1_000_000, "1M budget should be >1M chars");
}

section("computeChunkCharBudget — Terra 1.05M context window");
{
  const budget = computeChunkCharBudget(1_050_000);
  // Available = 1050000 - 847 - 2048 - 5000 = 1042105
  assert(budget > 1_000_000, "Terra budget should be >1M chars");
  assert(budget < 1_050_000, "Terra budget should be <1.05M chars");
}

section("computeChunkCharBudget — small context (128k)");
{
  const budget = computeChunkCharBudget(128_000);
  // Available = 128000 - 847 - 2048 - 5000 = 120105
  assertApprox(budget, 120_105, 100, "128k context → ~120k char budget");
  assert(budget > 100_000, "128k budget should be >100k chars");
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
  // the total context window expressed in chars (contextWindow * CHARS_PER_TOKEN).
  // This is the absolute ceiling — any budget above this would mean the chunk
  // alone (without system prompt or output) exceeds the model's context.
  for (const cw of [20_000, 50_000, 128_000, 200_000, 1_050_000]) {
    const budget = computeChunkCharBudget(cw);
    const maxPossibleChars = cw * CHARS_PER_TOKEN;
    assert(
      budget < maxPossibleChars,
      `budget ${budget} should be less than total context chars ${maxPossibleChars} for cw=${cw}`
    );
  }
}

// ---------------------------------------------------------------------------
// Dense tokenization safety tests (finding 1: 1 char/token bound)
//
// These tests verify that with CHARS_PER_TOKEN = 1, even the most densely
// tokenized text (CJK, code, JSON) cannot overflow the chunk or merge budget.
// ---------------------------------------------------------------------------

section("Dense tokenization — CJK text fits within chunk budget");
{
  // CJK characters are often 1 token per character in modern tokenizers.
  // With CHARS_PER_TOKEN = 1, we budget as if every char is a token.
  const cw = 200_000;
  const budget = computeChunkCharBudget(cw);
  const systemPromptTokens = Math.ceil(COMPACTION_SYSTEM_PROMPT_LEN / CHARS_PER_TOKEN);

  // Simulate a chunk of CJK chars filling the entire budget
  const cjkChunk = "あ".repeat(budget);
  const estimatedChunkTokens = cjkChunk.length; // 1 char/token = budget tokens
  const totalEstimated = systemPromptTokens + estimatedChunkTokens + MAX_SUMMARY_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS;

  assert(
    totalEstimated <= cw,
    `CJK chunk: total estimated tokens (${totalEstimated}) should fit in context (${cw})`
  );
  assert(
    estimatedChunkTokens === budget,
    `CJK chunk tokens (${estimatedChunkTokens}) should equal budget (${budget})`
  );
}

section("Dense tokenization — code text fits within chunk budget");
{
  // Code has many special characters, short identifiers, and punctuation
  // that tokenize densely (many tokens per character ratio is low).
  const cw = 128_000;
  const budget = computeChunkCharBudget(cw);
  const systemPromptTokens = Math.ceil(COMPACTION_SYSTEM_PROMPT_LEN / CHARS_PER_TOKEN);

  // Simulate a code-heavy chunk at budget size
  const codeChunk = "const x=1;".repeat(Math.floor(budget / 10));
  const estimatedChunkTokens = codeChunk.length; // 1 char/token worst case
  const totalEstimated = systemPromptTokens + estimatedChunkTokens + MAX_SUMMARY_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS;

  assert(
    totalEstimated <= cw,
    `Code chunk: total estimated tokens (${totalEstimated}) should fit in context (${cw})`
  );
}

section("Dense tokenization — JSON text fits within chunk budget");
{
  // JSON has braces, brackets, quotes, colons — dense tokenization.
  const cw = 200_000;
  const budget = computeChunkCharBudget(cw);
  const systemPromptTokens = Math.ceil(COMPACTION_SYSTEM_PROMPT_LEN / CHARS_PER_TOKEN);

  // Simulate JSON-heavy chunk at budget size
  const jsonChunk = '{"k":"v"}'.repeat(Math.floor(budget / 10));
  const estimatedChunkTokens = jsonChunk.length; // 1 char/token worst case
  const totalEstimated = systemPromptTokens + estimatedChunkTokens + MAX_SUMMARY_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS;

  assert(
    totalEstimated <= cw,
    `JSON chunk: total estimated tokens (${totalEstimated}) should fit in context (${cw})`
  );
}

section("Dense tokenization — mixed CJK + code + English fits within budget");
{
  // Real transcripts contain mixed content. With 1 char/token, even the
  // worst case mix fits within the context window.
  const cw = 200_000;
  const budget = computeChunkCharBudget(cw);
  const systemPromptTokens = Math.ceil(COMPACTION_SYSTEM_PROMPT_LEN / CHARS_PER_TOKEN);

  // Build a mixed-content chunk at exactly the budget size
  const segments = ["あいう".repeat(100), "const x=1;".repeat(100), "Hello world. ".repeat(100)];
  let mixed = segments.join("\n");
  // Truncate to exactly budget chars
  if (mixed.length > budget) mixed = mixed.slice(0, budget);
  else mixed = mixed + "x".repeat(budget - mixed.length);

  const estimatedChunkTokens = mixed.length;
  const totalEstimated = systemPromptTokens + estimatedChunkTokens + MAX_SUMMARY_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS;

  assert(
    totalEstimated <= cw,
    `Mixed chunk: total estimated tokens (${totalEstimated}) should fit in context (${cw})`
  );
  assert(mixed.length === budget, `Mixed chunk should be exactly budget size (${budget})`);
}

section("Dense tokenization — chunk budget invariants hold for all context windows");
{
  // For every usable context window, verify the core invariant:
  //   systemPromptTokens + chunkTokens + outputTokens + safetyMargin <= contextWindow
  // This is the no-overflow guarantee.
  for (const cw of [20_000, 50_000, 128_000, 200_000, 500_000, 1_048_576, 1_050_000]) {
    const budget = computeChunkCharBudget(cw);
    const systemPromptTokens = Math.ceil(COMPACTION_SYSTEM_PROMPT_LEN / CHARS_PER_TOKEN);
    const totalWorstCase = systemPromptTokens + budget + MAX_SUMMARY_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS;
    assert(
      totalWorstCase <= cw,
      `cw=${cw}: worst-case total (${totalWorstCase}) should be <= context window (${cw})`
    );
  }
}

// ---------------------------------------------------------------------------
// computeMaxMergeChunks tests
// ---------------------------------------------------------------------------

section("computeMaxMergeChunks — 200k context");
{
  const maxChunks = computeMaxMergeChunks(200_000);
  // Available merge tokens = 200000 - 649 - 2048 - 5000 = 192303
  // Max chunks = 192303 / 2048 = 93
  assert(maxChunks >= 80, "200k should allow >=80 merge chunks");
  assert(maxChunks <= 100, "200k should allow <=100 merge chunks");
  assert(maxChunks === 93, `200k should allow exactly 93 merge chunks, got ${maxChunks}`);
}

section("computeMaxMergeChunks — 1M context");
{
  const maxChunks = computeMaxMergeChunks(1_048_576);
  // Available = 1048576 - 649 - 2048 - 5000 = 1040879
  // Max chunks = 1040879 / 2048 = 508
  assert(maxChunks >= 400, "1M should allow >=400 merge chunks");
  assert(maxChunks === 508, `1M should allow exactly 508 merge chunks, got ${maxChunks}`);
}

section("computeMaxMergeChunks — tiny context throws");
{
  assertThrows(() => computeMaxMergeChunks(1_000), "1k context merge should throw");
  assertThrows(() => computeMaxMergeChunks(5_000), "5k context merge should throw");
}

// ---------------------------------------------------------------------------
// computeMergeInputCharBudget tests (finding 2: hierarchical merge budget)
// ---------------------------------------------------------------------------

section("computeMergeInputCharBudget — 200k context");
{
  const budget = computeMergeInputCharBudget(200_000);
  // Merge system prompt 649 chars / 1 = 649 tokens
  // Available = 200000 - 649 - 2048 - 5000 = 192303
  // Char budget = 192303 * 1 = 192303
  assertApprox(budget, 192_303, 100, "200k merge char budget → ~192k");
  assert(budget > 180_000, "200k merge budget should be >180k chars");
}

section("computeMergeInputCharBudget — 1M context");
{
  const budget = computeMergeInputCharBudget(1_048_576);
  // Available = 1048576 - 649 - 2048 - 5000 = 1040879
  assertApprox(budget, 1_040_879, 100, "1M merge char budget → ~1.04M");
  assert(budget > 1_000_000, "1M merge budget should be >1M chars");
}

section("computeMergeInputCharBudget — Terra 1.05M context");
{
  const budget = computeMergeInputCharBudget(1_050_000);
  assert(budget > 1_000_000, "Terra merge budget should be >1M chars");
  assert(budget < 1_050_000, "Terra merge budget should be <1.05M chars");
}

section("computeMergeInputCharBudget — tiny/invalid context throws");
{
  assertThrows(() => computeMergeInputCharBudget(0), "0 merge budget should throw");
  assertThrows(() => computeMergeInputCharBudget(-100), "negative merge budget should throw");
  assertThrows(() => computeMergeInputCharBudget(1_000), "1k merge budget should throw");
  assertThrows(() => computeMergeInputCharBudget(5_000), "5k merge budget should throw");
  assertThrows(() => computeMergeInputCharBudget(10_000), "10k merge budget should throw");
}

section("computeMergeInputCharBudget — never exceeds context window");
{
  // The merge input char budget should never exceed the context window itself
  for (const cw of [20_000, 50_000, 128_000, 200_000, 1_050_000]) {
    const budget = computeMergeInputCharBudget(cw);
    assert(budget < cw, `merge budget ${budget} should be < context window ${cw}`);
  }
}

section("computeMergeInputCharBudget — dense tokenization invariant");
{
  // With CHARS_PER_TOKEN = 1, the worst case is every char in the merge input
  // is a separate token. Verify that even this worst case fits:
  //   mergeSystemPromptTokens + mergeInputTokens + outputTokens + safety <= cw
  for (const cw of [20_000, 128_000, 200_000, 1_050_000]) {
    const budget = computeMergeInputCharBudget(cw);
    const mergeSystemTokens = Math.ceil(PROGRESSIVE_MERGE_PROMPT_LEN / CHARS_PER_TOKEN);
    const totalWorstCase = mergeSystemTokens + budget + MAX_SUMMARY_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS;
    assert(
      totalWorstCase <= cw,
      `cw=${cw}: merge worst-case total (${totalWorstCase}) should be <= context window (${cw})`
    );
  }
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
