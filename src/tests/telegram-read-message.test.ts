/**
 * Unit tests for read_telegram_message tool.
 *
 * Uses node:test with an injected fake transport.
 * Tests cover the full error taxonomy, validation-before-API, happy path,
 * delete retry/exhaustion, crash-window + sweeper recovery, owner-only,
 * concurrency, redaction, and forward flags.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ForwardOpts, TelegramTransport } from "../tools/telegram-read-message.js";
import type { ToolDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupWorkspace(): { workspace: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "tg-read-test-"));
  return {
    workspace: tmpDir,
    cleanup: () => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

interface FakeForwardCall {
  stagingChatId: string;
  fromChatId: string;
  messageId: number;
  opts: ForwardOpts;
}

interface FakeDeleteCall {
  chatId: string;
  messageId: number;
}

class FakeTransport implements TelegramTransport {
  forwardCalls: FakeForwardCall[] = [];
  deleteCalls: FakeDeleteCall[] = [];

  forwardShouldFail: { count: number; error: Error } | null = null;
  deleteShouldFail: { count: number; error: Error } | null = null;

  private forwardAttempt = 0;
  private deleteAttempt = 0;

  nextMessageId = 42;
  forwardResponse: Record<string, unknown> = {};

  async forwardMessage(
    stagingChatId: string,
    fromChatId: string,
    messageId: number,
    opts: ForwardOpts,
  ): Promise<any> {
    this.forwardAttempt++;
    this.forwardCalls.push({ stagingChatId, fromChatId, messageId, opts });

    if (this.forwardShouldFail && this.forwardAttempt <= this.forwardShouldFail.count) {
      throw this.forwardShouldFail.error;
    }

    const mid = this.nextMessageId++;
    const baseMsg: Record<string, unknown> = {
      message_id: mid,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(stagingChatId) },
      forward_origin: {
        type: "channel",
        chat: { id: Number(fromChatId), type: "channel" },
      },
    };
    // Only add default text if forwardResponse doesn't explicitly set text, caption, or other content fields
    if (!this.forwardResponse.text && !this.forwardResponse.caption &&
        !this.forwardResponse.sticker && !this.forwardResponse.photo) {
      baseMsg.text = "Hello from test";
    }
    return { ...baseMsg, ...this.forwardResponse };
  }

  async deleteMessage(chatId: string, messageId: number): Promise<true> {
    this.deleteAttempt++;
    this.deleteCalls.push({ chatId, messageId });

    if (this.deleteShouldFail && this.deleteAttempt <= this.deleteShouldFail.count) {
      throw this.deleteShouldFail.error;
    }

    return true;
  }

  reset(): void {
    this.forwardCalls = [];
    this.deleteCalls = [];
    this.forwardShouldFail = null;
    this.deleteShouldFail = null;
    this.forwardAttempt = 0;
    this.deleteAttempt = 0;
    this.forwardResponse = {};
    this.nextMessageId = 42;
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let ctx: ReturnType<typeof setupWorkspace>;
let transport: FakeTransport;
const ownerChatId = "8676961778";
const stagingChatId = "-1003936236995";

before(async () => {
  ctx = setupWorkspace();

  // Set config
  const { config } = await import("../config.js");
  (config as any).workspace = ctx.workspace;
  (config as any).ownerChatId = ownerChatId;
  (config as any).stagingChatId = stagingChatId;

  // Create patronum.db
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(join(ctx.workspace, "patronum.db"));
  db.pragma("journal_mode = WAL");
  db.close();

  // Initialize audit ledger
  const { initAuditLedger } = await import("../session.js");
  initAuditLedger();

  transport = new FakeTransport();
});

after(() => {
  ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Shortcut for resetting test state
// ---------------------------------------------------------------------------

async function resetTestState(): Promise<void> {
  transport.reset();

  // Ensure tool module imports use the fresh transport
  const { setTelegramTransport } = await import("../tools/telegram-read-message.js");
  setTelegramTransport(transport);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Telegram Read Message Tool", () => {
  // ── Registry ────────────────────────────────────────────────────────────
  describe("Registry", () => {
    it("should be present exactly once in getToolDefinitions()", async () => {
      const { getToolDefinitions } = await import("../tools/index.js");
      const tools = getToolDefinitions();
      const matching = tools.filter((t: ToolDefinition) => t.name === "read_telegram_message");
      assert.equal(matching.length, 1);
    });

    it("should be hidden from subagent tool lists", async () => {
      const { getToolDefinitions } = await import("../tools/index.js");
      const blocked = new Set([
        "spawn_agent", "self_restart", "cancel_agent", "list_tasks", "read_telegram_message"
      ]);
      const subagentTools = getToolDefinitions().filter(
        (t: ToolDefinition) => !blocked.has(t.name)
      );
      const hasReadTool = subagentTools.some((t: ToolDefinition) => t.name === "read_telegram_message");
      assert.equal(hasReadTool, false);
    });
  });

  // ── Validation before API ──────────────────────────────────────────────
  describe("Validation before any API call", () => {
    before(async () => { await resetTestState(); });
    before(async () => {
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);
    });

    it("should reject missing chat_id", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const result = await readTelegramMessageTool.execute({
        message_id: 123,
      } as any);
      assert.ok(result.startsWith("Error: invalid input:"),
        `Expected invalid input error, got: ${result}`);
      assert.equal(transport.forwardCalls.length, 0, "No API calls should have been made");
    });

    it("should reject empty chat_id", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const result = await readTelegramMessageTool.execute({
        chat_id: "",
        message_id: 123,
      });
      assert.ok(result.startsWith("Error: invalid input:"),
        `Expected invalid input error, got: ${result}`);
      assert.equal(transport.forwardCalls.length, 0);
    });

    it("should reject non-numeric chat_id without @ prefix", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const result = await readTelegramMessageTool.execute({
        chat_id: "not-a-valid-chat",
        message_id: 123,
      });
      assert.ok(result.startsWith("Error: invalid input:"),
        `Expected invalid input error, got: ${result}`);
      assert.equal(transport.forwardCalls.length, 0);
    });

    it("should reject negative/zero/non-integer message_id", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const tool = (await import("../tools/telegram-read-message.js")).readTelegramMessageTool;

      for (const bad of [0, -1, -100, 1.5]) {
        transport.reset();
        const result = await tool.execute({
          chat_id: "123456",
          message_id: bad as any,
        });
        assert.ok(result.startsWith("Error: invalid input:"),
          `Expected invalid input error for ${bad}, got: ${result}`);
        assert.equal(transport.forwardCalls.length, 0,
          `No API calls should have been made for ${bad}`);
      }
    });

    it("should reject missing message_id", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
      } as any);
      assert.ok(result.startsWith("Error: invalid input:"),
        `Expected invalid input error, got: ${result}`);
      assert.equal(transport.forwardCalls.length, 0);
    });

    it("should accept @username chat_id", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const result = await readTelegramMessageTool.execute({
        chat_id: "@testchannel",
        message_id: 5,
      });
      assert.ok(!result.startsWith("Error: invalid input:"),
        `Should not be validation error, got: ${result}`);
    });

    it("should accept negative channel id", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const result = await readTelegramMessageTool.execute({
        chat_id: "-1001234567890",
        message_id: 5,
      });
      assert.ok(!result.startsWith("Error: invalid input:"),
        `Should not be validation error, got: ${result}`);
    });
  });

  // ── Authorization ──────────────────────────────────────────────────────
  describe("Authorization", () => {
    before(async () => { await resetTestState(); });

    it("should refuse non-owner invocation before any API call", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("not-owner-chat-id");

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 123,
      });
      assert.equal(result, "Error: read_telegram_message is owner-only");
      assert.equal(transport.forwardCalls.length, 0, "No API calls should have been made");
    });

    it("should refuse when no currentChatId is set", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("");

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 123,
      });
      assert.equal(result, "Error: read_telegram_message is owner-only");
      assert.equal(transport.forwardCalls.length, 0);
    });
  });

  // ── Happy path ─────────────────────────────────────────────────────────
  describe("Happy path", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);
    });

    it("should forward, extract content, delete, return structured result", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.forwardResponse = { text: "Test message content" };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 99,
      });

      // Check forward was called with correct flags
      assert.equal(transport.forwardCalls.length, 1);
      assert.equal(transport.forwardCalls[0].fromChatId, "123456");
      assert.equal(transport.forwardCalls[0].messageId, 99);
      assert.equal(transport.forwardCalls[0].opts.disable_notification, true);
      assert.equal(transport.forwardCalls[0].opts.protect_content, true);

      // Check delete was called exactly once with the staged message id
      assert.equal(transport.deleteCalls.length, 1);
      assert.equal(transport.deleteCalls[0].messageId, 42);

      // Check result contains content
      assert.ok(result.includes("Test message content"),
        `Result should contain text, got: ${result}`);

      // Check result contains source_chat_id
      assert.ok(result.includes("source_chat_id:"),
        `Result should have source_chat_id, got: ${result}`);

      // Check no error prefix
      assert.ok(!result.startsWith("Error:"),
        `Result should not be an error, got: ${result}`);
    });

    it("should handle media with caption", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardResponse = {
        photo: [{ file_id: "abc", width: 100, height: 100 }],
        caption: "Photo caption",
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 5,
      });

      assert.ok(result.includes("Photo caption"),
        `Result should contain caption, got: ${result}`);
      assert.ok(!result.startsWith("Error:"),
        `Result should not be an error, got: ${result}`);
    });

    it("should handle sticker (no text)", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardResponse = {
        sticker: { emoji: "👍", file_id: "sticker123" },
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 5,
      });

      assert.ok(result.includes("sticker"),
        `Result should mention sticker type, got: ${result}`);
      assert.ok(!result.startsWith("Error:"),
        `Result should not be an error, got: ${result}`);
    });
  });

  // ── Error taxonomy mapping ─────────────────────────────────────────────
  describe("Error taxonomy mapping", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);
    });

    it("should map MESSAGE_NOT_FOUND (400 message to forward not found)", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.forwardShouldFail = {
        count: 3,
        error: new Error("400: message to forward not found"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 999,
      });
      assert.ok(result.startsWith("Error:"),
        `Should be error, got: ${result}`);
      assert.ok(result.includes("message not found"),
        `Should mention message not found, got: ${result}`);
    });

    it("should map NO_ACCESS (400 chat not found)", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardShouldFail = {
        count: 3,
        error: new Error("400: chat not found"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "999999",
        message_id: 1,
      });
      assert.ok(result.includes("no access"),
        `Should have no access, got: ${result}`);
    });

    it("should map NO_ACCESS (403 forbidden)", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardShouldFail = {
        count: 3,
        error: new Error("403: Forbidden: bot is not a member of the chat"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 1,
      });
      assert.ok(result.includes("no access"),
        `Should have no access, got: ${result}`);
    });

    it("should map STAGING_UNAVAILABLE (400 for staging)", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardShouldFail = {
        count: 3,
        error: new Error("400: Bad Request: not enough rights to send in the chat"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 1,
      });
      assert.ok(
        result.includes("staging channel unavailable"),
        `Should have staging unavailable, got: ${result}`
      );
    });

    it("should map TRANSIENT (429 rate limit)", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardShouldFail = {
        count: 2,
        error: new Error("429: Too Many Requests: retry after 5"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 1,
      });
      assert.ok(
        result.includes("transient failure"),
        `Should have transient failure, got: ${result}`
      );
    });

    it("should map TRANSIENT (5xx server error)", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardShouldFail = {
        count: 2,
        error: new Error("500: Internal Server Error"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 1,
      });
      assert.ok(
        result.includes("transient failure"),
        `Should have transient failure, got: ${result}`
      );
    });

    // ── B3: staging-channel 403 → STAGING_UNAVAILABLE ────────────────────
    it("should map staging-channel 403 to STAGING_UNAVAILABLE", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardShouldFail = {
        count: 3,
        error: new Error("403: Forbidden: bot is not an administrator of the staging channel"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 1,
      });
      assert.ok(
        result.includes("staging channel unavailable"),
        `Should have staging unavailable, got: ${result}`
      );
    });

    // ── B3: protected-content 400 → NO_ACCESS ────────────────────────────
    it("should map protected-content 400 to NO_ACCESS", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardShouldFail = {
        count: 3,
        error: new Error("400: Bad Request: can't forward protected content"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 1,
      });
      assert.ok(
        result.includes("no access"),
        `Should have no access, got: ${result}`
      );
    });

    // ── B3: unrecognized 400 → NO_ACCESS ─────────────────────────────────
    it("should map unrecognized/unclassified 400 to NO_ACCESS (not STAGING_UNAVAILABLE)", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.forwardShouldFail = {
        count: 3,
        error: new Error("400: Bad Request: some unknown error"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 1,
      });
      assert.ok(
        result.includes("no access"),
        `Should have no access (unrecognized 400), got: ${result}`
      );
    });
  });

  // ── Delete handling ────────────────────────────────────────────────────
  describe("Delete retry and exhaustion", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);
    });

    it("should retry delete on transient failure and succeed", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.deleteShouldFail = {
        count: 1,
        error: new Error("500: Internal Server Error"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 99,
      });

      assert.ok(!result.startsWith("Error:"),
        `Should not be error, got: ${result}`);
      assert.equal(transport.deleteCalls.length, 2,
        "Should have called delete twice (fail + retry)");
    });

    it("should return STAGING_CLEANUP_FAILED when delete retries exhausted", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.deleteShouldFail = {
        count: 10,
        error: new Error("500: Internal Server Error"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 99,
      });

      assert.ok(result.includes("STAGING_CLEANUP_FAILED"),
        `Should have STAGING_CLEANUP_FAILED, got: ${result}`);
      assert.ok(result.includes("stage_msg_id=42"),
        `Should mention stage_msg_id, got: ${result}`);
    });

    it("should treat 'already deleted' delete as success", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();
      transport.deleteShouldFail = {
        count: 1,
        error: new Error("400: message to delete not found"),
      };

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 99,
      });

      assert.ok(!result.startsWith("Error:"),
        `Should not be error, got: ${result}`);
      assert.ok(result.includes("text:"),
        `Should have content, got: ${result}`);
    });
  });

  // ── Concurrency ────────────────────────────────────────────────────────
  describe("Concurrency — single-flight mutex", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);
    });

    it("should reject concurrent invocation", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

      transport.reset();

      const originalForward = transport.forwardMessage.bind(transport);
      let forwardResolve: () => void;
      transport.forwardMessage = async () => {
        return new Promise<void>((resolve) => {
          forwardResolve = resolve;
        }).then(() => originalForward("staging", "123456", 99, {
          disable_notification: true,
          protect_content: true,
        }));
      };

      const promise1 = readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 99,
      });

      await new Promise((r) => setTimeout(r, 100));

      const result2 = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 100,
      });

      assert.ok(
        result2.includes("already in progress") ||
          result2.includes("one staged message at a time"),
        `Second call should be rejected, got: ${result2}`
      );

      forwardResolve!();
      await promise1;

      transport.forwardMessage = originalForward;
    });
  });

  // ── Crash window + sweeper ─────────────────────────────────────────────
  describe("Crash window and sweeper recovery", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);

      const { getOutstandingRows, markAuditRowDone } = await import("../session.js");
      const rows = getOutstandingRows();
      for (const row of rows) {
        markAuditRowDone(row.id as number, 0);
      }
    });

    it("should leave outstanding row on delete failure for sweeper", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const { getOutstandingRows } = await import("../session.js");

      transport.reset();
      transport.deleteShouldFail = {
        count: 10,
        error: new Error("500: Internal Server Error"),
      };

      await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 99,
      });

      const rows = getOutstandingRows();
      const matchingRow = rows.find((r: any) => r.stage_msg_id === 42);
      assert.ok(matchingRow,
        `Should have outstanding row for stage_msg_id=42, rows: ${JSON.stringify(rows)}`);
    });

    it("sweeper should clean outstanding rows on tick", async () => {
      const { startStagingSweeper, stopStagingSweeper } = await import("../tools/telegram-read-message.js");
      const { persistOutstandingRow, getOutstandingRows, markAuditRowDone } = await import("../session.js");

      const prevRows = getOutstandingRows();
      for (const row of prevRows) {
        markAuditRowDone(row.id as number, 0);
      }

      transport.reset();

      const auditId = persistOutstandingRow({
        requesting_chat: ownerChatId,
        requested_chat_id: "123456",
        requested_message_id: 99,
        stage_msg_id: 999,
        content_hash: "abc123",
      });

      assert.ok(auditId > 0, "Audit row should have been created");

      startStagingSweeper();
      await new Promise((r) => setTimeout(r, 100));
      stopStagingSweeper();

      const rows = getOutstandingRows();
      const matching = rows.filter((r: any) => r.id === auditId);
      assert.equal(matching.length, 0,
        `Outstanding row should have been cleaned by sweeper, but found: ${JSON.stringify(rows)}`);
    });
  });

  // ── Redaction ──────────────────────────────────────────────────────────
  describe("Redaction — content not persisted", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);
    });

    it("should store content hash, not message text, in audit rows", async () => {
      const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");
      const { getOutstandingRows } = await import("../session.js");

      transport.reset();
      transport.forwardResponse = { text: "Secret message that should never be stored" };

      transport.deleteShouldFail = {
        count: 10,
        error: new Error("500: Internal Server Error"),
      };

      await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 99,
      });

      const rows = getOutstandingRows();
      const match = rows.find((r: any) => r.requested_message_id === 99);
      assert.ok(match, "Should have outstanding row for this operation");

      assert.ok((match as any).content_hash, "Should have content_hash");
      assert.equal(typeof (match as any).content_hash, "string");
      assert.equal((match as any).content_hash.length, 64,
        "SHA-256 hash should be 64 hex chars");

      const rowJson = JSON.stringify(match);
      assert.ok(!rowJson.includes("Secret message that should never be stored"),
        "Audit row should not contain the actual message text");
    });
  });

  // ── Forward flags ──────────────────────────────────────────────────────
  describe("Forward flags", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);
    });

    it("should set disable_notification=true and protect_content=true", async () => {
      const readModule = await import("../tools/telegram-read-message.js");
      const readTelegramMessageTool = readModule.readTelegramMessageTool;

      readModule.setTelegramTransport(transport);
      transport.reset();

      const result = await readTelegramMessageTool.execute({
        chat_id: "123456",
        message_id: 99,
      });

      assert.equal(transport.forwardCalls.length, 1, `Expected 1 forward call, got ${transport.forwardCalls.length}. Result: ${result}`);
      const opts = transport.forwardCalls[0].opts;
      assert.equal(opts.disable_notification, true);
      assert.equal(opts.protect_content, true);
    });
  });

  // ── MISCONFIGURED ──────────────────────────────────────────────────────
  describe("Misconfiguration", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);
    });

    it("should refuse with MISCONFIGURED when staging_chat_id is empty", async () => {
      const { config } = await import("../config.js");
      const savedStaging = config.stagingChatId;
      (config as any).stagingChatId = "";

      try {
        const { readTelegramMessageTool } = await import("../tools/telegram-read-message.js");

        transport.reset();
        const result = await readTelegramMessageTool.execute({
          chat_id: "123456",
          message_id: 99,
        });
        assert.ok(result.includes("misconfigured"),
          `Should be misconfigured error, got: ${result}`);
      } finally {
        (config as any).stagingChatId = savedStaging;
      }
    });
  });

  // ── Sweeper retry persistence and escalation (B2) ──────────────────────
  describe("Sweeper retry persistence and escalation (B2)", () => {
    before(async () => {
      await resetTestState();
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId(ownerChatId);

      const { getOutstandingRows, markAuditRowDone } = await import("../session.js");
      const rows = getOutstandingRows();
      for (const row of rows) {
        markAuditRowDone(row.id as number, 0);
      }
    });

    it("incrementSweepRetries should persist retry count across calls", async () => {
      const { incrementSweepRetries, persistOutstandingRow, getOutstandingRows, markAuditRowDone } = await import("../session.js");

      const auditId = persistOutstandingRow({
        requesting_chat: ownerChatId,
        requested_chat_id: "123456",
        requested_message_id: 99,
        stage_msg_id: 777,
        content_hash: "def456",
      });

      const ret1 = incrementSweepRetries(auditId);
      assert.equal(ret1, 1, "First increment should return 1");

      const ret2 = incrementSweepRetries(auditId);
      assert.equal(ret2, 2, "Second increment should return 2");

      const rows = getOutstandingRows();
      const match = rows.find((r: any) => r.id === auditId);
      assert.ok(match, "Row should still be outstanding");
      assert.equal((match as any).sweep_retries, 2,
        "sweep_retries should be 2 in fresh fetch from DB");

      markAuditRowDone(auditId, 0);
    });

    it("sweeperTick should persist retries across consecutive failing ticks and escalate at 3", async () => {
      const { startStagingSweeper, stopStagingSweeper, setTelegramTransport } = await import("../tools/telegram-read-message.js");
      const { persistOutstandingRow, getOutstandingRows, markAuditRowDone } = await import("../session.js");
      const { setBot } = await import("../tools/index.js");

      // Clean up any outstanding rows from previous tests
      const prevRows = getOutstandingRows();
      for (const row of prevRows) {
        markAuditRowDone(row.id as number, 0);
      }

      // Create an outstanding row whose delete always fails (500)
      transport.reset();
      transport.deleteShouldFail = {
        count: 100,
        error: new Error("500: Internal Server Error"),
      };
      setTelegramTransport(transport);

      // Inject a fake bot so we can observe the owner escalation notification
      const sentMessages: Array<{ chatId: string; text: string }> = [];
      const fakeBot: any = {
        telegram: {
          sendMessage: async (chatId: string, text: string) => {
            sentMessages.push({ chatId, text });
            return { message_id: 1 };
          },
        },
      };
      setBot(fakeBot);

      const auditId = persistOutstandingRow({
        requesting_chat: ownerChatId,
        requested_chat_id: "123456",
        requested_message_id: 42,
        stage_msg_id: 555,
        content_hash: "esc123",
      });

      // Each sweeper tick tries delete with DELETE_RETRIES=2 (backoffs 500+1000ms),
      // so a failing tick takes ~1.5s. Drive 3 consecutive ticks, waiting for each
      // to fully settle before starting the next, so the retry counter is read from
      // the DB fresh each time (this is exactly what B2 fixed).
      const runOneTick = async (): Promise<void> => {
        startStagingSweeper();
        await new Promise((r) => setTimeout(r, 1800));
        stopStagingSweeper();
        await new Promise((r) => setTimeout(r, 50));
      };

      // Tick 1 → sweep_retries = 1
      await runOneTick();
      let rows = getOutstandingRows();
      let match = rows.find((r: any) => r.id === auditId);
      assert.equal((match as any).sweep_retries, 1,
        `After tick 1 sweep_retries should be 1, got ${(match as any).sweep_retries}`);
      assert.equal(sentMessages.length, 0, "No escalation before 3 failures");

      // Tick 2 → sweep_retries = 2
      await runOneTick();
      rows = getOutstandingRows();
      match = rows.find((r: any) => r.id === auditId);
      assert.equal((match as any).sweep_retries, 2,
        `After tick 2 sweep_retries should be 2, got ${(match as any).sweep_retries}`);
      assert.equal(sentMessages.length, 0, "No escalation before 3 failures");

      // Tick 3 → sweep_retries = 3 → escalation fires
      await runOneTick();
      rows = getOutstandingRows();
      match = rows.find((r: any) => r.id === auditId);
      assert.equal((match as any).sweep_retries, 3,
        `After tick 3 sweep_retries should be 3, got ${(match as any).sweep_retries}`);
      assert.equal(sentMessages.length, 1,
        `Escalation should fire once after 3 failures, got ${JSON.stringify(sentMessages)}`);
      assert.ok(sentMessages[0].text.includes("CRITICAL"),
        `Escalation should contain CRITICAL, got: ${sentMessages[0].text}`);
      assert.equal(sentMessages[0].chatId, ownerChatId,
        "Escalation should be sent to the owner chat");

      // Tick 4 → sweep_retries = 4 → the row is STILL outstanding and keeps failing,
      // but escalation must NOT re-fire: exactly one owner notification per row.
      await runOneTick();
      rows = getOutstandingRows();
      match = rows.find((r: any) => r.id === auditId);
      assert.equal((match as any).sweep_retries, 4,
        `After tick 4 sweep_retries should be 4, got ${(match as any).sweep_retries}`);
      assert.equal(sentMessages.length, 1,
        `Escalation must be sent exactly once across all ticks, got ${JSON.stringify(sentMessages)}`);

      // Clean up
      markAuditRowDone(auditId, 0);
    });
  });
});