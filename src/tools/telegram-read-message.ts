/**
 * read_telegram_message — forward-based read of a Telegram message by ID.
 *
 * Workaround: Bot API has no getMessage. We forward the target message to a
 * staging channel (the bot must be admin there), read the response for content,
 * then delete the staged copy.
 *
 * Safety invariants:
 *  - Owner-only invocation (currentChatId === config.ownerChatId)
 *  - Single-flight mutex (≤1 staged message at a time)
 *  - Audit row persisted BEFORE delete attempt (covers crash window)
 *  - Staging id from config, never from tool args
 *  - Content hash only in audit rows, never message text
 *  - disable_notification + protect_content on every forward
 */

import { createHash } from "node:crypto";
import type { Telegraf } from "telegraf";
import type { ToolHandler } from "../types.js";
import type { Message as TgMessage } from "telegraf/types";
import { config } from "../config.js";
import { getBot } from "./send-media.js";
import { getCurrentChatId } from "./chat-context.js";
import {
  initAuditLedger,
  persistOutstandingRow,
  markAuditRowDone,
  getOutstandingRows,
  incrementSweepRetries,
} from "../session.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGE_ID = 2147483647;
const DELETE_RETRIES = 2;
const DELETE_BACKOFFS: number[] = [500, 1000];
const SWEEPER_INTERVAL_MS = 30_000; // 30s

// ---------------------------------------------------------------------------
// Single-flight mutex — one staged message at a time
// ---------------------------------------------------------------------------

let inFlightPromise: Promise<void> | null = null;
let releaseInFlight: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Fake-transport injection for tests
// ---------------------------------------------------------------------------

export interface ForwardOpts {
  disable_notification: boolean;
  protect_content: boolean;
}

export interface TelegramTransport {
  forwardMessage(
    stagingChatId: string,
    fromChatId: string,
    messageId: number,
    opts: ForwardOpts,
  ): Promise<TgMessage>;
  deleteMessage(chatId: string, messageId: number): Promise<true>;
}

let transportOverride: TelegramTransport | null = null;

export function setTelegramTransport(t: TelegramTransport | null): void {
  transportOverride = t;
}

function getTransport(): TelegramTransport {
  if (transportOverride) return transportOverride;

  const bot = getBot();
  if (!bot) {
    throw new TelegramReadError(
      "MISCONFIGURED",
      "Bot instance not available",
    );
  }

  return {
    forwardMessage: (stagingChatId, fromChatId, messageId, opts) =>
      bot.telegram.forwardMessage(stagingChatId, fromChatId, messageId, opts),
    deleteMessage: (chatId, messageId) =>
      bot.telegram.deleteMessage(chatId, messageId).then(() => true as const),
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export type ReadErrorClass =
  | "INVALID_INPUT"
  | "NOT_AUTHORIZED"
  | "MISCONFIGURED"
  | "STAGING_UNAVAILABLE"
  | "MESSAGE_NOT_FOUND"
  | "NO_ACCESS"
  | "TRANSIENT"
  | "STAGING_CLEANUP_FAILED";

export class TelegramReadError extends Error {
  constructor(
    public readonly errorClass: ReadErrorClass,
    message: string,
  ) {
    super(message);
    this.name = "TelegramReadError";
  }
}

function classifyForwardError(err: unknown): TelegramReadError {
  const msg = err instanceof Error ? err.message : String(err);

  // 429 rate limit
  if (msg.includes("429") || /too many requests/i.test(msg)) {
    return new TelegramReadError("TRANSIENT", msg);
  }

  // 5xx server errors
  if (/5\d{2}/.test(msg)) {
    return new TelegramReadError("TRANSIENT", msg);
  }

  // 403 — discriminate staging vs source
  if (msg.includes("403")) {
    // If the error is about the staging channel (bot not admin, can't post there, etc.)
    if (/staging/i.test(msg)) {
      return new TelegramReadError("STAGING_UNAVAILABLE", msg);
    }
    // Any other 403 (bot not in source chat, forbidden source message, etc.) -> NO_ACCESS
    return new TelegramReadError("NO_ACCESS", msg);
  }

  // 400 — discriminate by description substring
  if (msg.includes("400")) {
    if (msg.includes("message to forward not found")) {
      return new TelegramReadError("MESSAGE_NOT_FOUND", msg);
    }
    if (msg.includes("chat not found")) {
      return new TelegramReadError("NO_ACCESS", msg);
    }
    // "can't forward protected content" means the source message is protected — NO_ACCESS
    if (/protected content/i.test(msg)) {
      return new TelegramReadError("NO_ACCESS", msg);
    }
    // "not enough rights to send in the chat" — the bot can't post into the
    // destination (staging) channel — STAGING_UNAVAILABLE
    if (/not enough rights to send/i.test(msg)) {
      return new TelegramReadError("STAGING_UNAVAILABLE", msg);
    }
    // "message to delete not found" is handled separately in delete
    // Other 400 from forward mentioning the staging channel — STAGING_UNAVAILABLE
    if (/channel|staging/i.test(msg)) {
      return new TelegramReadError("STAGING_UNAVAILABLE", msg);
    }
    // Unrecognized 400 codes → NO_ACCESS (likely a permission/access issue with source)
    return new TelegramReadError("NO_ACCESS", msg);
  }

  // Default: transient
  return new TelegramReadError("TRANSIENT", msg);
}

function classifyDeleteError(err: unknown): { alreadyClean: boolean; error: Error | null } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("400") && msg.includes("message to delete not found")) {
    return { alreadyClean: true, error: null };
  }
  return { alreadyClean: false, error: err instanceof Error ? err : new Error(String(err)) };
}

// ---------------------------------------------------------------------------
// Content hashing — never store message text, only a hash
// ---------------------------------------------------------------------------

function contentHash(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

// ---------------------------------------------------------------------------
// Delete with bounded retries
// ---------------------------------------------------------------------------

async function deleteWithRetry(
  transport: TelegramTransport,
  stagingChatId: string,
  stagedMsgId: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= DELETE_RETRIES; attempt++) {
    try {
      await transport.deleteMessage(stagingChatId, stagedMsgId);
      return;
    } catch (err: unknown) {
      const { alreadyClean, error } = classifyDeleteError(err);
      if (alreadyClean) return;
      lastError = error ?? new Error(String(err));

      if (attempt < DELETE_RETRIES) {
        const backoffMs = DELETE_BACKOFFS[attempt] ?? 1000;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  throw lastError ?? new Error("Delete exhausted");
}

// ---------------------------------------------------------------------------
// Sweeper — retries outstanding cleanup on startup + interval
// ---------------------------------------------------------------------------

let sweeperTimer: ReturnType<typeof setInterval> | null = null;

export function startStagingSweeper(): void {
  // Ensure audit ledger exists
  initAuditLedger();

  // Immediate tick at startup
  sweeperTick().catch((err) => {
    console.error("[read-telegram] Sweeper startup tick failed:", err);
  });

  if (sweeperTimer) clearInterval(sweeperTimer);
  sweeperTimer = setInterval(() => {
    sweeperTick().catch((err) => {
      console.error("[read-telegram] Sweeper interval tick failed:", err);
    });
  }, SWEEPER_INTERVAL_MS);
  if (sweeperTimer && typeof sweeperTimer === "object" && "unref" in sweeperTimer) {
    sweeperTimer.unref();
  }
}

export function stopStagingSweeper(): void {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}

async function sweeperTick(): Promise<void> {
  const rows = getOutstandingRows();
  if (rows.length === 0) return;

  const stagingChatId = config.stagingChatId;
  if (!stagingChatId) return;

  let transport: TelegramTransport;
  try {
    transport = getTransport();
  } catch {
    console.warn("[read-telegram] Sweeper: bot not available, skipping tick");
    return;
  }

  const bot = getBot();

  for (const row of rows) {
    try {
      await deleteWithRetry(transport, stagingChatId, row.stage_msg_id);
      markAuditRowDone(row.id, 0);
      console.log(
        `[read-telegram] Sweeper cleaned stage_msg_id=${row.stage_msg_id} (audit id=${row.id})`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[read-telegram] Sweeper FAILED for audit id=${row.id}, stage_msg_id=${row.stage_msg_id}: ${msg}`,
      );

      // Persist the retry count so it survives across sweeper ticks
      const retriesSoFar = incrementSweepRetries(row.id);

      // Escalate to owner exactly once, when the retry count first reaches 3.
      // Using === (not >=) is deliberate: on later ticks (retries 4, 5, …) the
      // row is still outstanding, but the owner has already been notified, so we
      // must NOT re-send — this guarantees exactly one notification per escalation.
      if (retriesSoFar === 3 && bot) {
        const ownerChatId = config.ownerChatId;
        if (ownerChatId) {
          try {
            await bot.telegram.sendMessage(
              ownerChatId,
              `⚠️ CRITICAL: Staging channel cleanup persistently failing for staged message ${row.stage_msg_id} (audit id=${row.id}). Manual cleanup required.`,
            );
          } catch {
            // fire-and-forget
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateChatId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  if (/^@\w+$/.test(trimmed)) return trimmed;
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  return null;
}

function validateMessageId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_MESSAGE_ID) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && String(parsed) === trimmed && parsed >= 1 && parsed <= MAX_MESSAGE_ID) {
      return parsed;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function executeReadTelegramMessage(input: Record<string, unknown>): Promise<string> {
  // ── 1. VALIDATE (before any API call) ──────────────────────────────────
  const chatIdValid = validateChatId(input.chat_id);
  if (!chatIdValid) {
    return `Error: invalid input: chat_id must be a non-empty string matching @username or numeric id, got "${String(input.chat_id)}"`;
  }

  const msgId = validateMessageId(input.message_id);
  if (!msgId) {
    return `Error: invalid input: message_id must be an integer in [1, ${MAX_MESSAGE_ID}], got "${String(input.message_id)}"`;
  }

  // ── 2. AUTHORIZE (before any API call) ─────────────────────────────────
  const currentChatId = getCurrentChatId();
  if (!currentChatId || currentChatId !== config.ownerChatId) {
    return "Error: read_telegram_message is owner-only";
  }

  if (!config.stagingChatId || config.stagingChatId.trim() === "") {
    return "Error: misconfigured: staging_chat_id not configured";
  }

  let transport: TelegramTransport;
  try {
    transport = getTransport();
  } catch (err: unknown) {
    const msg = err instanceof TelegramReadError ? err.message : String(err);
    return `Error: misconfigured: ${msg}`;
  }

  // ── 3. ACQUIRE single-flight mutex ─────────────────────────────────────
  if (inFlightPromise) {
    return "Error: read_telegram_message already in progress — one staged message at a time";
  }

  inFlightPromise = new Promise<void>((resolve) => {
    releaseInFlight = resolve;
  });

  const startTime = Date.now();
  const stagingChatId = config.stagingChatId;

  try {
    // ── 4. FORWARD ───────────────────────────────────────────────────────
    let forwardResponse: TgMessage;
    try {
      forwardResponse = await transport.forwardMessage(
        stagingChatId,
        chatIdValid,
        msgId,
        { disable_notification: true, protect_content: true },
      );
    } catch (err: unknown) {
      const classified = classifyForwardError(err);
      if (classified.errorClass === "TRANSIENT") {
        // One retry for transient forward failures
        try {
          forwardResponse = await transport.forwardMessage(
            stagingChatId,
            chatIdValid,
            msgId,
            { disable_notification: true, protect_content: true },
          );
        } catch (err2: unknown) {
          return `Error: transient failure: ${err2 instanceof Error ? err2.message : String(err2)}`;
        }
      } else {
        return `Error: ${formatError(classified)}`;
      }
    }

    const stagedMsgId = forwardResponse.message_id;
    if (typeof stagedMsgId !== "number" || stagedMsgId < 1) {
      return `Error: staging channel unavailable: invalid response from forwardMessage (missing message_id)`;
    }

    // ── 5. PERSIST outstanding audit row BEFORE delete ───────────────────
    const hash = contentHash(forwardResponse);
    const auditId = persistOutstandingRow({
      requesting_chat: currentChatId,
      requested_chat_id: chatIdValid,
      requested_message_id: msgId,
      stage_msg_id: stagedMsgId,
      content_hash: hash,
    });

    // ── 6. EXTRACT content from the forward response ─────────────────────
    const resultParts: string[] = [];

    let textContent: string | null = null;
    const fwd = forwardResponse as unknown as Record<string, unknown>;
    if (typeof fwd.text === "string") {
      textContent = fwd.text;
    } else if (typeof fwd.caption === "string") {
      textContent = fwd.caption;
    }

    if (textContent) {
      resultParts.push(`text: ${textContent}`);
    }

    // Report media type
    if (fwd.sticker) {
      const emoji = (fwd.sticker as Record<string, unknown>)?.emoji || "?";
      resultParts.push(`type: sticker (emoji: ${emoji})`);
    } else if (Array.isArray(fwd.photo)) {
      resultParts.push(`type: photo (${(fwd.photo as unknown[]).length} size(s))`);
    } else if (fwd.video) {
      resultParts.push(`type: video`);
    } else if (fwd.audio) {
      resultParts.push(`type: audio`);
    } else if (fwd.document) {
      resultParts.push(`type: document`);
    } else if (fwd.voice) {
      resultParts.push(`type: voice`);
    } else if (fwd.poll) {
      resultParts.push(`type: poll`);
    } else if (!textContent) {
      resultParts.push(`type: unknown (no text content)`);
    }

    // Forward origin
    const forwardOrigin = fwd.forward_origin as Record<string, unknown> | undefined;
    if (forwardOrigin) {
      const originChat = forwardOrigin.chat as Record<string, unknown> | undefined;
      if (originChat && typeof originChat.id === "number") {
        const actualChatId = String(originChat.id);
        resultParts.push(`source_chat_id: ${actualChatId}`);
        if (actualChatId !== chatIdValid) {
          resultParts.push(
            `note: forward_origin.chat.id (${actualChatId}) differs from requested chat_id (${chatIdValid})`,
          );
        }
      } else {
        resultParts.push(
          `source_chat_id: ${chatIdValid} (forward_origin.chat.id not available for private-chat sources)`,
        );
      }
    } else {
      resultParts.push(`source_chat_id: ${chatIdValid} (forward_origin not available)`);
    }

    // Date
    if (typeof forwardResponse.date === "number") {
      resultParts.push(`date: ${new Date(forwardResponse.date * 1000).toISOString()}`);
    }

    const structuredResult = resultParts.join("\n");

    // ── 7. DELETE staged copy (with retries) ────────────────────────────
    try {
      await deleteWithRetry(transport, stagingChatId, stagedMsgId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Audit row stays outstanding — sweeper will retry
      console.error(
        `[read-telegram] Delete failed for stage_msg_id=${stagedMsgId} (audit id=${auditId}): ${msg}`,
      );
      return `Error: STAGING_CLEANUP_FAILED stage_msg_id=${stagedMsgId} reason=${msg}`;
    }

    // ── 8. MARK audit row done ──────────────────────────────────────────
    const durationMs = Date.now() - startTime;
    markAuditRowDone(auditId, durationMs);

    console.log(
      `[read-telegram] Read message ${msgId} from ${chatIdValid} (stage=${stagedMsgId}, ${durationMs}ms)`,
    );

    return structuredResult;
  } finally {
    releaseInFlight?.();
    inFlightPromise = null;
    releaseInFlight = null;
  }
}

function formatError(e: TelegramReadError): string {
  switch (e.errorClass) {
    case "INVALID_INPUT":
      return `invalid input: ${e.message}`;
    case "NOT_AUTHORIZED":
      return `read_telegram_message is owner-only`;
    case "MISCONFIGURED":
      return `misconfigured: ${e.message}`;
    case "STAGING_UNAVAILABLE":
      return `staging channel unavailable: ${e.message}`;
    case "MESSAGE_NOT_FOUND":
      return `message not found: ${e.message}`;
    case "NO_ACCESS":
      return `no access to source chat/message: ${e.message}`;
    case "TRANSIENT":
      return `transient failure: ${e.message}`;
    case "STAGING_CLEANUP_FAILED":
      return `STAGING_CLEANUP_FAILED: ${e.message}`;
    default:
      return e.message;
  }
}

// ---------------------------------------------------------------------------
// Tool handler export
// ---------------------------------------------------------------------------

export const readTelegramMessageTool: ToolHandler = {
  definition: {
    name: "read_telegram_message",
    description:
      "Read a Telegram message by chat_id and message_id using a staging-channel forward workaround. " +
      "Returns the message text (or media type + metadata). Owner-only; one invocation at a time.",
    input_schema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description:
            'Chat containing the target message. Accepts private chat id ("8676961778"), ' +
            'channel id ("-1003936236995"), or public username ("@channelname"). Required.',
        },
        message_id: {
          type: "integer",
          description: "Target message id. Integer in [1, 2147483647]. Required.",
        },
      },
      required: ["chat_id", "message_id"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    return executeReadTelegramMessage(input);
  },
};