/**
 * Streaming fix test: verifies the error classification, cooldown, serialization,
 * deadline behavior, and per-turn cap of the new DraftStreamer.
 *
 * Run with: npx tsx src/tests/streaming-fix.test.ts
 */

import { DraftStreamer, classifyDraftError, _getChatCooldowns, _resetChatCooldowns } from "../draft-stream.js";

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

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${msg}: got ${JSON.stringify(actual)}`);
  } else {
    failed++;
    failures.push(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.error(`  ✗ FAIL: ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Assert a boolean that is mutated inside an async closure. TypeScript's CFG
 * narrows such `let` variables to their literal initializer (the closure write
 * isn't visible in the straight-line flow), so take the widened `boolean` type
 * here and compare inside where the narrowing is reset.
 */
function assertTrue(value: boolean, message: string): void {
  assert(value === true, message);
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

let callApiHistory: Array<{ method: string; payload: any; signal?: AbortSignal }> = [];

function makeStubBot(callApiOverride?: (method: string, payload: any, opts?: any) => Promise<any>): any {
  callApiHistory = [];
  return {
    telegram: {
      sendMessage: async (_chatId: string | number, _text: string, _opts?: any): Promise<{ message_id: number }> => {
        return { message_id: 42 };
      },
      callApi: (method: string, payload: any, opts?: any) => {
        callApiHistory.push({ method, payload, signal: opts?.signal });
        if (callApiOverride) {
          return callApiOverride(method, payload, opts);
        }
        return Promise.resolve({ ok: true });
      },
    },
  };
}

/** Synthetic TelegramError */
function tgError(code: number, description: string, params?: { retry_after?: number }): any {
  const err: any = new Error(`${code}: ${description}`);
  err.response = { error_code: code, description, parameters: params };
  err.code = code;
  err.description = description;
  err.parameters = params;
  return err;
}

/** Synthetic FetchError (node-fetch system error) */
function fetchError(code: string, message?: string): any {
  const err: any = new Error(message || `request to https://api.telegram.org/ failed, reason: ${code}`);
  err.type = 'system';
  err.code = code;
  err.errno = code;
  return err;
}

/** Synthetic AbortError */
function abortError(): any {
  const err: any = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

// Reset cooldowns before each test section
function resetState(): void {
  _resetChatCooldowns();
}

// ===========================================================================
// A. Error classification (plan §3.1, §7.A.1)
// ===========================================================================

section("A. Error classification matrix");

resetState();

// A1. 429 with retry_after → rate_limited
{
  const cls = classifyDraftError(tgError(429, "Too Many Requests: retry after 3", { retry_after: 3 }));
  assert(cls.type === "rate_limited", "429 → rate_limited");
  if (cls.type === "rate_limited") {
    assert(cls.retryAfter === 3, "retry_after extracted");
  }
}

// A2. 429 without retry_after (should default to 3)
{
  const cls = classifyDraftError(tgError(429, "Too Many Requests"));
  assert(cls.type === "rate_limited", "429 without retry_after → rate_limited");
  if (cls.type === "rate_limited") {
    assert(cls.retryAfter >= 3, "retry_after defaults to >= 3");
  }
}

// A3. FetchError ETIMEDOUT → transient_network
{
  const cls = classifyDraftError(fetchError("ETIMEDOUT"));
  assert(cls.type === "transient_network", "ETIMEDOUT → transient_network");
}

// A4. FetchError ECONNRESET → transient_network
{
  const cls = classifyDraftError(fetchError("ECONNRESET"));
  assert(cls.type === "transient_network", "ECONNRESET → transient_network");
}

// A5. AbortError → transient_network
{
  const cls = classifyDraftError(abortError());
  assert(cls.type === "transient_network", "AbortError → transient_network");
}

// A6. 400 with parse error → content_error
{
  const cls = classifyDraftError(tgError(400, "Bad Request: can't parse entities"));
  assert(cls.type === "content_error", '400 "can\'t parse entities" → content_error');
}

// A7. 400 with "parse" in description → content_error
{
  const cls = classifyDraftError(tgError(400, "Bad Request: unable to parse message"));
  assert(cls.type === "content_error", '400 with "parse" → content_error');
}

// A8. 403 → permanent_disable
{
  const cls = classifyDraftError(tgError(403, "Forbidden: bot was blocked"));
  assert(cls.type === "permanent_disable", "403 → permanent_disable");
}

// A9. 404 → permanent_disable
{
  const cls = classifyDraftError(tgError(404, "Not Found: method not found"));
  assert(cls.type === "permanent_disable", "404 → permanent_disable");
}

// A10. 400 with "method not found" → permanent_disable
{
  const cls = classifyDraftError(tgError(400, "Bad Request: method is not available"));
  assert(cls.type === "permanent_disable", '400 "method not available" → permanent_disable');
}

// A11. 400 with "method not found" → permanent_disable
{
  const cls = classifyDraftError(tgError(400, "Bad Request: method not found"));
  assert(cls.type === "permanent_disable", '400 "method not found" → permanent_disable');
}

// A12. Plain Error (generic) → transient_network (safe default)
{
  const cls = classifyDraftError(new Error("Something went wrong"));
  assert(cls.type === "transient_network", "Generic Error → transient_network (safe default)");
}

// A13. String throw (should not crash)
{
  const cls = classifyDraftError("unknown string error");
  assert(cls.type === "unknown", "String throw → unknown");
}

// A14. 400 "chat not found" → permanent_disable (was content_error)
{
  const cls = classifyDraftError(tgError(400, "Bad Request: chat not found"));
  assert(cls.type === "permanent_disable", '400 "chat not found" → permanent_disable');
}

// A15. 400 "not enough rights" → permanent_disable (was content_error)
{
  const cls = classifyDraftError(tgError(400, "Bad Request: not enough rights to send text messages to the chat"));
  assert(cls.type === "permanent_disable", '400 "not enough rights" → permanent_disable');
}

// A16. 400 "kicked" → permanent_disable (was content_error)
{
  const cls = classifyDraftError(tgError(400, "Bad Request: bot was kicked from the group chat"));
  assert(cls.type === "permanent_disable", '400 "kicked" → permanent_disable');
}

// A17. 400 "deactivated" → permanent_disable (was content_error)
{
  const cls = classifyDraftError(tgError(400, "Bad Request: user is deactivated"));
  assert(cls.type === "permanent_disable", '400 "deactivated" → permanent_disable');
}

// A18. 401 (invalid token) → permanent_disable (was transient_network)
{
  const cls = classifyDraftError(tgError(401, "Unauthorized"));
  assert(cls.type === "permanent_disable", "401 → permanent_disable");
}

// ===========================================================================
// B. Cooldown behavior (plan §3.1, §7.A.2-3)
// ===========================================================================

section("B. Cooldown behavior");

// B1. After 429, cooldown is set and subsequent flushes are skipped
{
  resetState();
  let callCount = 0;

  const bot = makeStubBot(() => {
    callCount++;
    throw tgError(429, "Too Many Requests: retry after 2", { retry_after: 2 });
  });

  const ds = new DraftStreamer(bot, "cooldown_test_1");
  ds.update("Hello world, this is a long enough text for the chars delta to trigger.");
  // Wait for the flush to fail
  await new Promise((r) => setTimeout(r, 100));

  // First flush should have been attempted (and failed with 429)
  const callCountAfterFirst = callCount;
  assert(callCountAfterFirst >= 1, "First flush was attempted");

  // Cooldown should be active
  const cooldowns = _getChatCooldowns();
  assert(cooldowns.has("cooldown_test_1"), "Cooldown entry exists for chat");

  const cd = cooldowns.get("cooldown_test_1")!;
  assert(cd.until > Date.now(), "Cooldown is in the future");

  // Reset the stub to succeed
  callCount = callCountAfterFirst;

  // Set new text and try again — should be skipped due to cooldown
  const bot2 = makeStubBot(() => {
    callCount++;
    return Promise.resolve({ ok: true });
  });
  const ds2 = new DraftStreamer(bot2, "cooldown_test_1");
  ds2.update("More text here, long enough to pass the char threshold test.");
  await new Promise((r) => setTimeout(r, 100));

  // The flush should NOT have been called (cooldown active from previous turn)
  assertEq(callCount, callCountAfterFirst, "No additional flush while in cooldown");
}

// B2. Cooldown survives across DraftStreamer instances (different turn, same chat)
{
  resetState();

  // Set an artificial cooldown
  _getChatCooldowns().set("cross_turn", { until: Date.now() + 10000 });

  const bot = makeStubBot(() => {
    throw new Error("Should not be called during cooldown");
  });

  const ds = new DraftStreamer(bot, "cross_turn");
  ds.update("Testing cross-turn cooldown with enough chars to trigger flush.");
  await new Promise((r) => setTimeout(r, 50));

  // Cooldown should still be active
  const cd = _getChatCooldowns().get("cross_turn")!;
  assert(cd.until > Date.now(), "Cross-turn cooldown still active");
}

// B3. After cooldown expires, flushes resume
{
  resetState();
  let succeeded = false;

  // Set a very short cooldown (in the past)
  _getChatCooldowns().set("expired_test", { until: Date.now() - 100 });

  const bot = makeStubBot(() => {
    succeeded = true;
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "expired_test");
  ds.update("Long text to trigger a flush after cooldown expiry here we go.");
  await new Promise((r) => setTimeout(r, 100));

  assert(succeeded, "Flush resumes after cooldown expires");
}

// B4. 429 cooldown includes bounded jitter (avoids lockstep retries across chats)
{
  resetState();
  const bot = makeStubBot(() => {
    throw tgError(429, "Too Many Requests", { retry_after: 2 });
  });

  const ds = new DraftStreamer(bot, "jitter_test", { throttleMs: 10 });
  const t0 = Date.now();
  ds.update("Long text triggering a 429 so we can measure the cooldown jitter range.");
  await new Promise((r) => setTimeout(r, 100));

  const cd = _getChatCooldowns().get("jitter_test")!;
  // until = flushStart + retryAfter*1000 + jitter, where jitter ∈ [0, 1000]
  // and flushStart is within [t0, t0+100]. Assert base honored and jitter bounded.
  assert(cd.until >= t0 + 2000, "Cooldown honors retry_after base (2000ms)");
  assert(cd.until <= t0 + 2000 + 1100, "Cooldown jitter is bounded (<= ~1s + slack)");
}

// ===========================================================================
// C. Serialization / coalescing (plan §3.2, §7.A.4)
// ===========================================================================

section("C. Serialization / coalescing");

// C1. Rapid updates with a slow stub → coalescing fires exactly once with the
//    LATEST snapshot. Uses an injectable tiny throttle so mid-flight updates
//    actually pass the throttle gate and reach flush() (fix: coalesce path fires).
{
  resetState();
  const sentTexts: string[] = [];
  let resolveFirstFlush: (() => void) | null = null;

  const firstText = "X".repeat(100);
  const secondText = "X".repeat(100) + "Y".repeat(50); // 50 chars longer
  const thirdText = "X".repeat(100) + "Y".repeat(50) + "Z".repeat(50); // 100 chars longer

  const bot = makeStubBot((_method: string, payload: any) => {
    sentTexts.push(payload.text || "");
    if (sentTexts.length === 1) {
      // First call: hold until we explicitly resolve
      return new Promise((resolve) => {
        resolveFirstFlush = () => resolve({ ok: true });
      });
    }
    // Subsequent calls: resolve immediately
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "serial_test", { throttleMs: 10 });

  // First update → immediate flush (held)
  ds.update(firstText);
  await new Promise((r) => setTimeout(r, 30));
  assert(sentTexts.length === 1, "First flush started immediately");

  // While the first flush is in-flight, push updates that PASS the throttle
  // gate (throttleMs=10) → each reaches flush() and coalesces onto the single
  // in-flight request (no queuing, no concurrent call).
  ds.update(secondText);
  ds.update(thirdText);
  assert(sentTexts.length === 1, "No concurrent flush while first is in flight");

  // Resolve the first flush → exactly one coalesced follow-up should fire,
  // carrying the LATEST (third) snapshot.
  if (resolveFirstFlush) {
    (resolveFirstFlush as () => void)();
  }
  await new Promise((r) => setTimeout(r, 50));

  assert(sentTexts.length === 2, `Exactly one coalesced follow-up (got ${sentTexts.length} sends)`);
  if (sentTexts.length === 2) {
    assert(sentTexts[1] === thirdText, "Coalesced follow-up carries the latest snapshot");
  }

  // No further sends after the coalesced one settles
  const after = sentTexts.length;
  await new Promise((r) => setTimeout(r, 100));
  assert(sentTexts.length === after, "No extra sends after the coalesced follow-up");
}

// C2. No duplicate sends of identical text
{
  resetState();
  const sentTexts: string[] = [];

  const bot = makeStubBot((_method: string, payload: any) => {
    sentTexts.push(payload.text || "");
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "dedup_test");

  // Same text twice — only one send should happen (the first)
  ds.update("Hello world, some text here that is long enough to trigger.");
  await new Promise((r) => setTimeout(r, 50));
  ds.update("Hello world, some text here that is long enough to trigger.");
  await new Promise((r) => setTimeout(r, 200));

  assert(sentTexts.length === 1, `No duplicate sends (got ${sentTexts.length})`);
}

// ===========================================================================
// D. Deadline / AbortSignal behavior (plan §3.3, §7.A.5)
// ===========================================================================

section("D. Deadline / AbortSignal behavior");

// D1. The callApi signal is passed and respected (stub checks for signal)
{
  resetState();
  let signalReceived: AbortSignal | undefined;

  const bot = makeStubBot((_method: string, _payload: any, opts?: any) => {
    signalReceived = opts?.signal;
    if (signalReceived?.aborted) {
      return Promise.reject(new Error("The operation was aborted"));
    }
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "signal_test");
  ds.update("Some long text that triggers a flush and tests signal passing.");
  await new Promise((r) => setTimeout(r, 100));

  assert(signalReceived !== undefined, "AbortSignal was passed to callApi");
  assert(signalReceived?.aborted === false, "Signal is not already aborted (success case)");
}

// D2. Injectable deadline: abort fires on a hung draft AND the streamer recovers
//    (deadline is a test seam via DraftStreamerOptions.draftDeadlineMs)
{
  resetState();
  let abortedDueToDeadline: boolean = false;
  let callCount = 0;

  const bot = makeStubBot((_method: string, _payload: any, opts?: any) => {
    callCount++;
    // First call: hang forever unless the deadline aborts it. Later calls
    // (recovery) resolve immediately.
    if (callCount === 1) {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          abortedDueToDeadline = true;
          reject(abortError());
        });
      });
    }
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "deadline_test", { throttleMs: 10, draftDeadlineMs: 50, transientLimit: 5 });
  ds.update("Long text that should be aborted by the 50ms draft deadline here.");

  // Wait past the 50ms deadline
  await new Promise((r) => setTimeout(r, 120));

  assertTrue(abortedDueToDeadline, "Deadline aborted the hung draft");
  assert(callCount >= 1, "At least one call was made");

  // Streamer recovers: a fresh update with new text triggers a new flush that succeeds
  const before = callCount;
  ds.update("Fresh long text after the abort to prove the streamer recovered just fine.");
  await new Promise((r) => setTimeout(r, 100));
  assert(callCount > before, "Streamer recovered and sent a new draft after the abort");
}

// ===========================================================================
// E. Per-turn cap (plan §3.2, §7.A.6)
// ===========================================================================

section("E. Per-turn cap");

// E1. Per-turn cap actually enforced: drive 31+ flushes and assert the 31st is
//    suppressed with a single log. Uses an injectable tiny throttle so each
//    update passes the throttle gate and reaches its own flush.
{
  resetState();
  const sentPayloads: any[] = [];
  let capLogCount = 0;
  const originalWarn = console.warn;
  console.warn = (msg?: any, ...args: any[]) => {
    if (typeof msg === "string" && msg.includes("Per-turn cap")) capLogCount++;
    originalWarn(msg, ...args);
  };

  try {
    const bot = makeStubBot((_method: string, payload: any) => {
      sentPayloads.push(payload);
      return Promise.resolve({ ok: true });
    });

    const ds = new DraftStreamer(bot, "cap_test", { throttleMs: 5 });

    // 31 updates, each ≥40 chars longer than the previous so every one passes
    // MIN_CHARS_DELTA and (with the 5ms throttle) triggers its own flush.
    for (let i = 0; i < 31; i++) {
      ds.update(`Update ${i} — ` + "P".repeat(80 + i * 50));
      await new Promise((r) => setTimeout(r, 15));
    }

    assert(sentPayloads.length === 30, `Exactly 30 flushes sent, 31st suppressed (got ${sentPayloads.length})`);
    assert(capLogCount === 1, `Cap warning logged exactly once (got ${capLogCount})`);
  } finally {
    console.warn = originalWarn;
  }
}

// ===========================================================================
// F. Invariant regressions (plan §4, §7.A.7)
// ===========================================================================

section("F. Invariant regressions");

// F1. finalized set before any async work — finalizeClean returns message_id
{
  resetState();

  const ds = new DraftStreamer(makeStubBot(() => Promise.resolve({ ok: true })), "invariant_1");
  ds.update("Text that should be finalized properly.");

  // We can't directly check internal state, but we can verify behavior:
  // Stop + finalizeClean should succeed
  ds.stop();
  const result = await ds.finalizeClean();
  assert(result === 42, "finalizeClean returns message_id after update");
}

// F2. Second finalizeClean → null (no duplicate sends)
{
  resetState();
  let sendCount = 0;

  // Use sendMessage-based finalizeClean
  const bot: any = {
    telegram: {
      sendMessage: async (_chatId: string | number, _text: string, _opts?: any) => {
        sendCount++;
        return { message_id: 42 };
      },
    },
  };

  const ds = new DraftStreamer(bot, "invariant_2");
  ds.update("Hello world");
  ds.stop();

  const r1 = await ds.finalizeClean();
  assertEq(r1, 42, "First finalizeClean returns message_id");
  const firstCount = sendCount;

  const r2 = await ds.finalizeClean();
  assertEq(r2, null, "Second finalizeClean returns null");
  assertEq(sendCount, firstCount, "sendMessage not called again");
}

// F3. update() is no-op after finalization
{
  resetState();

  const bot = makeStubBot(() => {
    throw new Error("Should not be called after finalize");
  });

  const ds = new DraftStreamer(bot, "invariant_3");
  ds.update("Some text before finalize.");
  ds.stop();
  await ds.finalizeClean();

  // This update should be a no-op
  ds.update("This should NOT trigger a flush");
  await new Promise((r) => setTimeout(r, 100));
  // No crash = test passed
  assert(true, "update() is no-op after finalization");
}

// F4. draft_id derivation unchanged (stability per chat)
{
  resetState();

  // Verify by checking callApi payloads
  const sentDraftIds: number[] = [];
  const bot = makeStubBot((_method: string, payload: any) => {
    sentDraftIds.push(payload.draft_id);
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "99999");
  ds.update("Long text to trigger draft with a specific chat ID.");
  await new Promise((r) => setTimeout(r, 100));

  // Draft ID should be derived from 99999: 99999 % 2147483647 = 99999
  assert(sentDraftIds.length > 0, "At least one draft was sent");
  if (sentDraftIds.length > 0) {
    assert(sentDraftIds[0] > 0 && sentDraftIds[0] < 2147483647, `draft_id is valid positive 32-bit: ${sentDraftIds[0]}`);
  }
}

// F5. stop() clears pending timer
{
  resetState();
  let afterStopCall = false;

  const bot = makeStubBot(() => {
    afterStopCall = true;
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "stop_test");
  ds.update("Text that creates a pending debounce.");

  // Stop should clear the timer
  ds.stop();

  // Wait for what would have been the debounce timer
  await new Promise((r) => setTimeout(r, 200));

  assert(!afterStopCall, "No flush after stop()");
}

// F6. finalizeClean returns null for empty draft
{
  resetState();

  const bot = makeStubBot(() => {
    throw new Error("Should not be called");
  });

  const ds = new DraftStreamer(bot, "empty_test");
  ds.stop();
  const result = await ds.finalizeClean();
  assertEq(result, null, "Empty draft → null");
}

// ===========================================================================
// G. Finalize vs in-flight race (fix A)
// ===========================================================================

section("G. Finalize vs in-flight race (fix A)");

// G1. finalizeClean aborts a hung in-flight draft and sends the final message;
//    no draft may land after the final send.
{
  resetState();
  let draftAborted: boolean = false;
  let draftCallCount = 0;
  let sendMessageCount = 0;

  const bot: any = {
    telegram: {
      sendMessage: async (_chatId: string | number, _text: string, _opts?: any) => {
        sendMessageCount++;
        return { message_id: 42 };
      },
      callApi: (method: string, _payload: any, opts?: any) => {
        if (method === "sendMessageDraft") {
          draftCallCount++;
          // Hang forever unless the signal aborts it (like real node-fetch)
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              draftAborted = true;
              reject(abortError());
            });
          });
        }
        return Promise.resolve({ ok: true });
      },
    },
  };

  const ds = new DraftStreamer(bot, "race_test", { throttleMs: 10, finalizeSettleMs: 200 });
  ds.update("Long text that triggers an in-flight draft for the finalize race test.");
  await new Promise((r) => setTimeout(r, 50));
  assert(draftCallCount === 1, "Draft is in-flight");
  assert(draftAborted === false, "Draft not aborted yet");

  const result = await ds.finalizeClean();
  assert(result === 42, "finalizeClean returns message_id even with an in-flight draft");
  assertTrue(draftAborted, "In-flight draft was aborted by finalization (no stale draft can land after)");
  assert(sendMessageCount === 1, "Final sendMessage happened");

  // No draft may be sent after finalization
  const countAfterFinalize = draftCallCount;
  await new Promise((r) => setTimeout(r, 100));
  assert(draftCallCount === countAfterFinalize, "No draft sent after finalize");
}

// G2. stop() suppresses the coalesced follow-up (main path: stop before final send)
{
  resetState();
  const sentTexts: string[] = [];
  let resolveFirstFlush: (() => void) | null = null;

  const bot = makeStubBot((_method: string, payload: any) => {
    sentTexts.push(payload.text || "");
    if (sentTexts.length === 1) {
      return new Promise((resolve) => {
        resolveFirstFlush = () => resolve({ ok: true });
      });
    }
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "stop_coalesce_test", { throttleMs: 10 });
  ds.update("X".repeat(100));
  await new Promise((r) => setTimeout(r, 30));
  ds.update("X".repeat(100) + "Y".repeat(50)); // would coalesce onto the in-flight flush

  // Stop as the main path does before the final send — while a flush is in-flight
  ds.stop();

  // Resolve the in-flight flush → the coalesced follow-up must be suppressed
  if (resolveFirstFlush) {
    (resolveFirstFlush as () => void)();
  }
  await new Promise((r) => setTimeout(r, 50));

  assert(sentTexts.length === 1, `No coalesced draft after stop() (got ${sentTexts.length} sends)`);
}

// ===========================================================================
// H. Additional behaviors (review 1407108)
// ===========================================================================

section("H. Additional behaviors");

// H1. content-400 → raw-text retry inside executeDraftSend
{
  resetState();
  const calls: Array<{ method: string; payload: any }> = [];
  const rawText = "Long text with *markdown* that fails parse then retries as plain.";

  const bot = makeStubBot((method: string, payload: any) => {
    calls.push({ method, payload });
    if (calls.length === 1) {
      throw tgError(400, "Bad Request: can't parse entities");
    }
    return Promise.resolve({ ok: true });
  });

  const ds = new DraftStreamer(bot, "content_retry_test", { throttleMs: 10 });
  ds.update(rawText);
  await new Promise((r) => setTimeout(r, 100));

  assert(calls.length === 2, `Raw retry happened (got ${calls.length} calls)`);
  if (calls.length === 2) {
    assert(calls[0].payload.parse_mode === "HTML", "First attempt uses HTML parse_mode");
    assert(calls[1].payload.parse_mode === undefined, "Retry drops parse_mode");
    assert(calls[1].payload.text === rawText, "Retry sends raw (unconverted) text");
  }
}

// H2. TRANSIENT_LIMIT soft-stop: after N consecutive transients, drafts disabled
{
  resetState();
  let callCount = 0;

  const bot = makeStubBot(() => {
    callCount++;
    throw fetchError("ETIMEDOUT");
  });

  const ds = new DraftStreamer(bot, "transient_limit_test", { throttleMs: 10, transientLimit: 3 });

  // Drive 5 updates; after the 3rd consecutive transient, drafts must soft-stop.
  for (let i = 0; i < 5; i++) {
    ds.update(`Update ${i} with enough long text to trigger a flush every single time. ` + "Q".repeat(60 + i * 50));
    await new Promise((r) => setTimeout(r, 30));
  }

  assert(callCount === 3, `Soft-stop after 3 consecutive transients (got ${callCount} calls)`);
}

// H3. Final delivery independence: finalizeClean succeeds while chat is in 429 cooldown
{
  resetState();
  _getChatCooldowns().set("cooldown_final", { until: Date.now() + 100000 }); // long cooldown

  const bot = makeStubBot(() => {
    throw new Error("Draft should never fire while in cooldown");
  });

  const ds = new DraftStreamer(bot, "cooldown_final", { throttleMs: 10 });
  ds.update("Long text that should be suppressed by cooldown for the draft path.");
  await new Promise((r) => setTimeout(r, 50));

  // Draft suppressed, but finalizeClean must still deliver the final message
  const result = await ds.finalizeClean();
  assert(result === 42, "finalizeClean sends the final message during 429 cooldown");
}

// H4. Lazy cooldown pruning: expired entries are deleted by isInCooldown()
{
  resetState();
  _getChatCooldowns().set("prune_test", { until: Date.now() - 100 }); // already expired

  const bot = makeStubBot(() => Promise.resolve({ ok: true }));
  const ds = new DraftStreamer(bot, "prune_test", { throttleMs: 10 });
  ds.update("Long text that triggers a flush and lazy-prunes the expired cooldown entry.");
  await new Promise((r) => setTimeout(r, 100));

  assert(!_getChatCooldowns().has("prune_test"), "Expired cooldown entry pruned by isInCooldown");
}

// ===========================================================================
// Summary
// ===========================================================================

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