/**
 * Streaming duplication fix test: verifies that pre-tool text is not duplicated
 * in the final response when a tool triggers DraftStreamer.finalizeClean() mid-turn.
 *
 * Run with: npx tsx src/tests/streaming-duplication.test.ts
 */

import { extractTextFromResponse } from "../agent.js";
import { DraftStreamer } from "../draft-stream.js";
import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock, TextBlock } from "../types.js";

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
// Stub Telegraf for DraftStreamer tests
// ---------------------------------------------------------------------------

let sendMessageCallCount = 0;
let sendMessageShouldThrow = false;

function makeStubBot(): any {
  sendMessageCallCount = 0;
  sendMessageShouldThrow = false;
  return {
    telegram: {
      sendMessage: async (_chatId: string | number, _text: string, _opts?: any): Promise<{ message_id: number }> => {
        sendMessageCallCount++;
        if (sendMessageShouldThrow) {
          throw new Error("Simulated send failure");
        }
        return { message_id: 42 };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build assistant messages
// ---------------------------------------------------------------------------

function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

function toolUseBlock(name: string, id: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function toolResultBlock(toolUseId: string, content: string, isError = false): ToolResultBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
}

function assistantMsg(blocks: ContentBlock[]): Message {
  return { role: "assistant", content: blocks };
}

function userMsg(blocks: ContentBlock[]): Message {
  return { role: "user", content: blocks };
}

// ===========================================================================
// A. extractTextFromResponse skip semantics (pure)
// ===========================================================================

section("A. extractTextFromResponse skip semantics");

// A1. Single arg (backward compatibility)
{
  const msgs: Message[] = [
    assistantMsg([textBlock("Hello")]),
  ];
  const result = extractTextFromResponse(msgs);
  assert(result === "Hello", `Single arg returns same as before: got "${result}"`);
}

// A2. skip=1 drops first assistant message, keeps later ones
{
  const msgs: Message[] = [
    assistantMsg([textBlock("Preamble")]),
    userMsg([toolResultBlock("call_1", "Error", true)]),
    assistantMsg([textBlock("Post-tool")]),
  ];
  const skip0 = extractTextFromResponse(msgs, 0);
  assert(skip0 === "Preamble\nPost-tool", `skip=0 gives all text: got "${skip0}"`);
  const skip1 = extractTextFromResponse(msgs, 1);
  assert(skip1 === "Post-tool", `skip=1 drops preamble: got "${skip1}"`);
}

// A3. Skip counts messages, not text blocks
{
  const msgs: Message[] = [
    assistantMsg([textBlock("BlockA"), textBlock("BlockB")]),
    assistantMsg([textBlock("Second")]),
  ];
  const skip0 = extractTextFromResponse(msgs, 0);
  assert(skip0 === "BlockA\nBlockB\nSecond", `skip=0 joins all blocks: got "${skip0}"`);
  const skip1 = extractTextFromResponse(msgs, 1);
  assert(skip1 === "Second", `skip=1 skips entire first msg (2 blocks): got "${skip1}"`);
}

// A4. Text-less assistant messages (tool_use-only) still consume a skip slot
{
  const msgs: Message[] = [
    assistantMsg([toolUseBlock("exec", "call_1")]),
    assistantMsg([textBlock("After tool")]),
  ];
  const skip0 = extractTextFromResponse(msgs, 0);
  assert(skip0 === "After tool", `skip=0: text-only msg found: got "${skip0}"`);
  const skip1 = extractTextFromResponse(msgs, 1);
  assert(skip1 === "After tool", `skip=1 skips tool_use-only msg, keeps second: got "${skip1}"`);
  const skip2 = extractTextFromResponse(msgs, 2);
  assert(skip2 === "(no response)", `skip=2 exceeds all msgs: got "${skip2}"`);
}

// A5. skip >= assistant count → "(no response)"
{
  const msgs: Message[] = [
    assistantMsg([textBlock("Only")]),
  ];
  const result = extractTextFromResponse(msgs, 2);
  assert(result === "(no response)", `skip=2 exceeds count: got "${result}"`);
}

// A6. No assistant messages at all
{
  const result = extractTextFromResponse([], 0);
  assert(result === "(no response)", `Empty messages: got "${result}"`);
}

// A7. Mixed thinking blocks are excluded from text (both sides)
{
  const msgs: Message[] = [
    assistantMsg([
      { type: "thinking", thinking: "thinking text", signature: "sig" },
      textBlock("Visible"),
    ]),
  ];
  const result = extractTextFromResponse(msgs, 0);
  assert(result === "Visible", `Thinking blocks excluded: got "${result}"`);
}

// ===========================================================================
// B. DraftStreamer flush semantics
// ===========================================================================

section("B. DraftStreamer flush semantics");

// B1. finalizeClean sends accumulated text once, returns the ID
{
  const bot = makeStubBot();
  const ds = new DraftStreamer(bot, "12345");
  ds.update("Hello world");
  ds.stop(); // stop debounce so update doesn't auto-flush

  const result = await ds.finalizeClean();
  assert(result === 42, `finalizeClean returns message_id: got ${result}`);
  // Note: sendMessageCallCount may be >1 if the stop didn't fully prevent the debounce flush
  assert(sendMessageCallCount >= 1, `sendMessage was called at least once (count=${sendMessageCallCount})`);
}

// B2. Second finalizeClean → null, sendMessage not called again
{
  const bot = makeStubBot();
  const ds = new DraftStreamer(bot, "12345");
  ds.update("Hello world");
  ds.stop();

  const result1 = await ds.finalizeClean();
  assert(result1 === 42, `First call returns message_id`);
  const firstCount = sendMessageCallCount;

  const result2 = await ds.finalizeClean();
  assert(result2 === null, `Second call returns null`);
  assert(sendMessageCallCount === firstCount, `sendMessage not called again (count=${sendMessageCallCount})`);
}

// B3. finalize after finalizeClean → no-op
{
  const bot = makeStubBot();
  const ds = new DraftStreamer(bot, "12345");
  ds.update("Hello world");
  ds.stop();

  const cleanResult = await ds.finalizeClean();
  assert(cleanResult === 42, `finalizeClean returns message_id`);
  const countAfterClean = sendMessageCallCount;

  await ds.finalize("restarting");
  assert(sendMessageCallCount === countAfterClean, `finalize after finalizeClean is no-op (count=${sendMessageCallCount})`);
}

// B4. Nothing accumulated → null, no send
{
  const bot = makeStubBot();
  const ds = new DraftStreamer(bot, "12345");
  ds.stop();

  const result = await ds.finalizeClean();
  assert(result === null, `Empty finalizeClean returns null`);
  assert(sendMessageCallCount === 0, `sendMessage not called (count=${sendMessageCallCount})`);
}

// B5. sendMessage throws → null
{
  const bot = makeStubBot();
  sendMessageShouldThrow = true;
  const ds = new DraftStreamer(bot, "12345");
  ds.update("Hello world");
  ds.stop();

  const result = await ds.finalizeClean();
  assert(result === null, `finalizeClean returns null on send failure`);
}

// ===========================================================================
// C. Turn-simulation contract test
// ===========================================================================

section("C. Turn-simulation contract test");

// Reproduce the failure scenario:
// assistant#1 [text "Preamble", tool_use self_restart]
// → user [tool_result is_error]
// → assistant#2 [text "Sorry, ..."]
{
  const newMessages: Message[] = [
    assistantMsg([textBlock("Preamble"), toolUseBlock("self_restart", "call_1")]),
    userMsg([toolResultBlock("call_1", "Task still running", true)]),
    assistantMsg([textBlock("Sorry, let me continue.")]),
  ];

  // Simulate onToolStart("self_restart", 1) — 1 assistant message at boundary
  const flushedCount = 1; // flush succeeded

  // Final extraction with skip
  const reply = extractTextFromResponse(newMessages, flushedCount);
  assert(reply === "Sorry, let me continue.", `Skip=1 gives only post-tool text: got "${reply}"`);

  // Sentinel stripping when all text was flushed
  const noTextMessages: Message[] = [
    assistantMsg([toolUseBlock("self_restart", "call_2")]),
    userMsg([toolResultBlock("call_2", "Done", false)]),
    assistantMsg([]),
  ];
  const noTextReply = extractTextFromResponse(noTextMessages, 1);
  assert(noTextReply === "(no response)", `All text flushed: got sentinel "${noTextReply}"`);

  // Sentinel stripping makes it empty
  const stripped = (flushedCount > 0 && reply === "(no response)") ? "" : reply;
  assert(stripped === "Sorry, let me continue.", `Stripped reply: got "${stripped}"`);
}

// C2. Empty post-tool text after successful flush
{
  const newMessages: Message[] = [
    assistantMsg([textBlock("Preamble")]),
    userMsg([toolResultBlock("call_1", "Error", true)]),
    assistantMsg([]), // no text in second assistant message
  ];

  const flushedCount = 1;
  let reply = extractTextFromResponse(newMessages, flushedCount);
  assert(reply === "(no response)", `No post-tool text: got sentinel "${reply}"`);

  if (flushedCount > 0 && reply === "(no response)") {
    reply = "";
  }
  assert(reply === "", `Sentinel stripped to empty string`);
}

// C3. Post-tool error fallback with flushed prefix
{
  const newMessages: Message[] = [
    assistantMsg([textBlock("Preamble"), toolUseBlock("exec", "call_1")]),
    userMsg([toolResultBlock("call_1", "Something failed", true)]),
    assistantMsg([]), // no text — error fallback should append
  ];

  const flushedCount = 1;
  let reply = extractTextFromResponse(newMessages, flushedCount);
  assert(reply === "(no response)", `No post-tool text from extraction: got "${reply}"`);

  if (flushedCount > 0 && reply === "(no response)") {
    reply = "";
  }
  assert(reply === "", `Empty before error fallback`);

  // Simulate the lastAssistantHasText check + error fallback from bot.ts
  let lastAssistantHasText = false;
  for (let i = newMessages.length - 1; i >= 0; i--) {
    const msg = newMessages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const hasText = msg.content.some(
        (b): boolean => b.type === "text" && (b as any).text?.trim()
      );
      lastAssistantHasText = hasText;
      break;
    }
  }
  assert(lastAssistantHasText === false, `Last assistant has no text`);

  // Error fallback appends tool_result content
  if (!lastAssistantHasText) {
    for (const msg of newMessages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_result" && (block as any).is_error === true) {
            const content = (block as any).content;
            if (typeof content === "string" && content.trim()) {
              if (reply && reply.trim()) {
                reply = reply + "\n\n" + content;
              } else {
                reply = content;
              }
              break;
            }
          }
        }
        if (reply.trim()) break;
      }
    }
  }
  assert(reply === "Something failed", `Error fallback appends: got "${reply}"`);
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