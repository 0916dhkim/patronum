/**
 * Integration test: compactIfNeeded error-handling contract + context window
 * resolution.
 *
 * Verifies that compactIfNeeded:
 *   1. Preserves original history when summarization fails (empty response)
 *   2. Preserves original history when the LLM call throws
 *   3. Does NOT trigger compaction below the 70% threshold
 *   4. Does trigger compaction above the 70% threshold
 *   5. Skips compaction when context window cannot be resolved (finding 4)
 *   6. Skips compaction when context window is too small (finding 3)
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

// The model string determines the provider: "test/model" → OpenRouter.
// We mock the model API to return a 200k context window.
const TEST_MODEL = "test/test-model";
// 200k * 0.70 = 140k threshold

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

interface MockConfig {
  // Context window to return from the model API
  contextWindow?: number;
  // If true, model API returns 404 (simulates unknown model)
  modelApiNotFound?: boolean;
  // If true, model API throws (simulates network error)
  modelApiError?: boolean;
  // Chat completions response factory
  openrouter?: (body: any) => Response;
}

function mockFetch(cfg: MockConfig): void {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // Model metadata API: GET /api/v1/model/:id
    if (urlStr.includes("/api/v1/model/")) {
      if (cfg.modelApiError) {
        throw new Error("Network error: model API unreachable");
      }
      if (cfg.modelApiNotFound) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "Not Found", code: 404 } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      const cw = cfg.contextWindow ?? 200_000;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { context_length: cw, top_provider: { context_length: cw } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    // Chat completions API
    if (urlStr.includes("openrouter.ai")) {
      if (cfg.openrouter) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        return Promise.resolve(cfg.openrouter(body));
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
  mockFetch({ contextWindow: 200_000 });
  const result = await compactIfNeeded(messages, 50_000, TEST_MODEL); // 50k < 140k threshold
  assert(!result.compacted, "Should not compact below 70% threshold");
  assert(result.messages === messages, "Should return original messages reference");
}
restoreFetch();

section("Above threshold but LLM returns empty text — preserve history");
{
  const messages = makeMessages(50);
  mockFetch({
    contextWindow: 200_000,
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
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
    contextWindow: 200_000,
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
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
    contextWindow: 200_000,
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
    contextWindow: 200_000,
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
    contextWindow: 200_000,
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
  assert(result.messages[0].role === "user", "First message should be user (summary)");
  assert(result.messages[1].role === "assistant", "Second message should be assistant (ack)");
}
restoreFetch();

section("Tool-result boundary preservation — toKeep doesn't start with tool_result");
{
  const messages: Message[] = [];
  for (let i = 0; i < 15; i++) {
    messages.push({ role: "user", content: `User ${i}` });
    messages.push({ role: "assistant", content: `Assistant ${i}` });
  }
  messages.push({ role: "user", content: "Run tool please" });
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
    contextWindow: 200_000,
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

  const toKeep = result.messages.slice(2);
  const firstKeep = toKeep[0];
  const isToolResult =
    firstKeep.role === "user" &&
    Array.isArray(firstKeep.content) &&
    firstKeep.content.some((b) => b.type === "tool_result");
  assert(!isToolResult, "toKeep[0] should NOT be a tool_result message");
  assert(firstKeep.role === "user", "toKeep[0] should be a user message");
}
restoreFetch();

// ---------------------------------------------------------------------------
// Finding 4: Context window resolution tests
// ---------------------------------------------------------------------------

section("Context window resolution — model API returns context_length");
{
  // Use a unique model name that hasn't been cached by prior tests
  const uniqueModel = "test/context-resolution-test";
  const messages = makeMessages(50);
  let modelApiCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/api/v1/model/")) {
      modelApiCalled = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { context_length: 200_000 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (urlStr.includes("openrouter.ai")) {
      // Return a valid summary to confirm compaction runs
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "## Summary", tool_calls: null } }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  const result = await compactIfNeeded(messages, 150_000, uniqueModel);
  assert(modelApiCalled, "Model API should have been called for context window resolution");
  assert(result.compacted, "Compaction should succeed with resolved context window");
  globalThis.fetch = origFetch;
}

section("Context window resolution — model API returns 404, not in local table → skip");
{
  const messages = makeMessages(50);
  mockFetch({
    modelApiNotFound: true,
    contextWindow: 200_000, // won't be used since modelApiNotFound takes precedence
  });

  const result = await compactIfNeeded(messages, 150_000, "test/unknown-model");
  assert(!result.compacted, "Should skip compaction when context window cannot be resolved");
  assert(result.messages === messages, "Should return original messages");
}
restoreFetch();

section("Context window resolution — model API throws, not in local table → skip");
{
  const messages = makeMessages(50);
  mockFetch({
    modelApiError: true,
  });

  const result = await compactIfNeeded(messages, 150_000, "test/unknown-model");
  assert(!result.compacted, "Should skip compaction when model API is unreachable");
  assert(result.messages === messages, "Should return original messages");
}
restoreFetch();

section("Context window resolution — local fallback used when model API fails");
{
  // "z-ai/glm-5.2" is in LOCAL_CONTEXT_WINDOWS, so even if the API fails,
  // the local table should be used.
  const messages = makeMessages(50);
  mockFetch({
    modelApiError: true,
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "## Summary", tool_calls: null } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  // glm-5.2 has 1_048_576 context → 70% threshold = 734_003
  // 150k < 734k, so no compaction
  const result = await compactIfNeeded(messages, 150_000, "z-ai/glm-5.2");
  assert(!result.compacted, "Should not compact (150k < 734k threshold for glm-5.2)");

  // Now with enough tokens to trigger
  const result2 = await compactIfNeeded(messages, 800_000, "z-ai/glm-5.2");
  assert(result2.compacted, "Should compact (800k > 734k threshold for glm-5.2)");
}
restoreFetch();

section("Context window resolution — Terra model resolves correctly");
{
  // "openai/gpt-5.6-terra" is in LOCAL_CONTEXT_WINDOWS with 1_050_000
  const messages = makeMessages(50);
  mockFetch({
    modelApiError: true, // Force local fallback
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "## Summary", tool_calls: null } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  // Terra: 1_050_000 * 0.70 = 735_000 threshold
  // 140k (old wrong fallback) should NOT trigger
  const result = await compactIfNeeded(messages, 140_000, "openai/gpt-5.6-terra");
  assert(!result.compacted, "140k should NOT trigger on Terra (threshold 735k)");

  // 800k should trigger
  const result2 = await compactIfNeeded(messages, 800_000, "openai/gpt-5.6-terra");
  assert(result2.compacted, "800k should trigger on Terra (threshold 735k)");
}
restoreFetch();

// ---------------------------------------------------------------------------
// Finding 3: Tiny context window skips compaction
// ---------------------------------------------------------------------------

section("Tiny context window — skips compaction safely");
{
  const messages = makeMessages(50);
  mockFetch({
    contextWindow: 1_000, // Way too small
    openrouter: (_body: any) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "## Summary", tool_calls: null } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  // threshold = floor(1000 * 0.70) = 700, so 800 tokens would trigger threshold
  // But isContextWindowUsable(1000) = false, so compaction should be skipped
  const result = await compactIfNeeded(messages, 800, "test/tiny-model");
  assert(!result.compacted, "Should skip compaction on tiny context window");
  assert(result.messages === messages, "Should return original messages");
}
restoreFetch();

// ---------------------------------------------------------------------------
// Finding 2: Hierarchical/batched merge tests
// ---------------------------------------------------------------------------

/**
 * Helper: create messages large enough to force multiple chunks.
 * Each message has `charsPerMessage` characters of content.
 */
function makeLargeMessages(count: number, charsPerMessage: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    const userText = `User message ${i} `.repeat(Math.ceil(charsPerMessage / 14)).slice(0, charsPerMessage);
    messages.push({ role: "user", content: userText });
    const asstText = `Assistant response ${i} `.repeat(Math.ceil(charsPerMessage / 20)).slice(0, charsPerMessage);
    messages.push({ role: "assistant", content: asstText });
  }
  return messages;
}

/**
 * Mock fetch for hierarchical merge tests.
 * Differentiates summarization vs merge calls by inspecting the system prompt.
 * Returns `state` with call counts for assertions.
 */
interface MergeMockState {
  summarizeCount: number;
  mergeCount: number;
}

function mockFetchForMerge(
  contextWindow: number,
  summarizeResponse: string,
  mergeResponse: string,
  options?: { failOnNthMerge?: number; failOnNthSummary?: number; emptyOnNthMerge?: number }
): MergeMockState {
  const state: MergeMockState = { summarizeCount: 0, mergeCount: 0 };
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("/api/v1/model/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { context_length: contextWindow } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    if (urlStr.includes("openrouter.ai")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const systemText = body.system || "";
      const isMerge = systemText.includes("merging multiple sequential summaries");

      if (isMerge) {
        state.mergeCount++;
        if (options?.failOnNthMerge === state.mergeCount) {
          // Simulate API error
          return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
        }
        if (options?.emptyOnNthMerge === state.mergeCount) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { role: "assistant", content: "", tool_calls: null } }],
                usage: { prompt_tokens: 100, completion_tokens: 0 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: mergeResponse, tool_calls: null } }],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      } else {
        state.summarizeCount++;
        if (options?.failOnNthSummary === state.summarizeCount) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { role: "assistant", content: "", tool_calls: null } }],
                usage: { prompt_tokens: 100, completion_tokens: 0 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: summarizeResponse, tool_calls: null } }],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  return state;
}

// Use a small context window (20k = minimum usable) to force multiple chunks
// with a manageable number of messages.
// chunk budget = 20000 - 847 - 2048 - 5000 = 12105 chars
// threshold = floor(20000 * 0.70) = 14000
// merge budget = 20000 - 649 - 2048 - 5000 = 12303 chars

section("Hierarchical merge — multiple chunks, successful merge");
{
  // Create enough messages to exceed chunk budget multiple times.
  // 60 pairs × 1200 chars/pair ≈ 72k chars in toSummarize (after removing 20 recent)
  // → ~6 chunks with cw=20k (budget ~12k chars)
  const messages = makeLargeMessages(60, 600);
  // threshold = 14000, so inputTokens = 15000 triggers compaction
  const state = mockFetchForMerge(
    20_000,
    "## Current Objective\nChunk summary content for testing purposes.",
    "## Current Objective\nMerged final summary content.",
  );

  const result = await compactIfNeeded(messages, 15_000, "test/merge-test-model");
  assert(result.compacted, "Should compact successfully with multiple chunks");
  assert(result.messages !== messages, "Should return new messages array");
  assert(state.summarizeCount > 1, `Should have summarized multiple chunks (got ${state.summarizeCount})`);
  assert(state.mergeCount >= 1, `Should have performed at least one merge (got ${state.mergeCount})`);
  assert(result.messages[0].role === "user", "First message should be summary user message");

  const summaryContent = typeof result.messages[0].content === "string"
    ? result.messages[0].content
    : "";
  assert(
    summaryContent.includes("Merged final summary"),
    "Summary should contain merged content"
  );
}
restoreFetch();

section("Hierarchical merge — merge failure (empty response) preserves history");
{
  const messages = makeLargeMessages(60, 600);
  // Fail the first merge call with empty response
  const state = mockFetchForMerge(
    20_000,
    "## Current Objective\nChunk summary.",
    "## Current Objective\nMerged summary.",
    { emptyOnNthMerge: 1 }
  );

  const result = await compactIfNeeded(messages, 15_000, "test/merge-fail-model");
  assert(!result.compacted, "Should NOT compact when merge returns empty text");
  assert(result.messages === messages, "Should preserve original history on merge failure");
  assert(state.summarizeCount > 1, "Summarization should have occurred before merge failure");
  assert(state.mergeCount >= 1, "At least one merge attempt should have occurred");
}
restoreFetch();

section("Hierarchical merge — merge API error preserves history");
{
  const messages = makeLargeMessages(60, 600);
  mockFetchForMerge(
    20_000,
    "## Current Objective\nChunk summary.",
    "## Current Objective\nMerged summary.",
    { failOnNthMerge: 1 }
  );

  const result = await compactIfNeeded(messages, 15_000, "test/merge-api-error-model");
  assert(!result.compacted, "Should NOT compact when merge API returns error");
  assert(result.messages === messages, "Should preserve original history on merge API error");
}
restoreFetch();

section("Hierarchical merge — summarize failure on chunk 2 preserves history");
{
  const messages = makeLargeMessages(60, 600);
  const state = mockFetchForMerge(
    20_000,
    "## Current Objective\nChunk summary.",
    "## Current Objective\nMerged summary.",
    { failOnNthSummary: 2 }
  );

  const result = await compactIfNeeded(messages, 15_000, "test/summary-fail-model");
  assert(!result.compacted, "Should NOT compact when chunk summarization fails");
  assert(result.messages === messages, "Should preserve original history on summarization failure");
  assert(state.summarizeCount >= 2, "At least 2 summarize attempts should have occurred");
}
restoreFetch();

section("Hierarchical merge — single chunk, no merge needed");
{
  // Small enough to fit in a single chunk — no merge call should happen
  const messages = makeLargeMessages(15, 200);
  const state = mockFetchForMerge(
    200_000,
    "## Current Objective\nSingle summary.",
    "## Current Objective\nMerged summary.",
  );

  const result = await compactIfNeeded(messages, 150_000, "test/single-chunk-model");
  assert(result.compacted, "Should compact with single chunk");
  assert(state.summarizeCount === 1, `Should summarize exactly 1 chunk (got ${state.summarizeCount})`);
  assert(state.mergeCount === 0, `Should NOT merge with single chunk (got ${state.mergeCount})`);
}
restoreFetch();

section("Hierarchical merge — merge input never exceeds budget");
{
  // Verify that the merge call input stays within the safe budget.
  // We intercept the request body and check the total message length.
  let maxMergeInputChars = 0;
  const messages = makeLargeMessages(60, 600);

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("/api/v1/model/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { context_length: 20_000 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    if (urlStr.includes("openrouter.ai")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const systemText = body.system || "";
      const isMerge = systemText.includes("merging multiple sequential summaries");

      if (isMerge) {
        // Calculate total input chars (all messages combined)
        const inputChars = (body.messages || [])
          .map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
          .join("")
          .length;
        if (inputChars > maxMergeInputChars) maxMergeInputChars = inputChars;
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "## Summary", tool_calls: null } }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  const result = await compactIfNeeded(messages, 15_000, "test/budget-check-model");

  if (result.compacted) {
    // Merge budget for 20k context = 20000 - 649 - 2048 - 5000 = 12303 chars
    // The actual merge input should never exceed this
    assert(
      maxMergeInputChars <= 12_400, // small tolerance for framing
      `Merge input (${maxMergeInputChars} chars) should not exceed budget (~12303 chars)`
    );
  }
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
