import { Telegraf } from "telegraf";
import { markdownToTelegramHtml } from "./format.js";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type DraftErrorClass =
  | { type: "rate_limited"; retryAfter: number; original: unknown }
  | { type: "transient_network"; original: unknown }
  | { type: "content_error"; original: unknown }
  | { type: "permanent_disable"; original: unknown }
  | { type: "unknown"; original: unknown };

/**
 * Classify a draft-flush error according to the streaming-fix architecture.
 *
 * Rate-limited:       TelegramError 429 (with optional retry_after)
 * Transient network:  node-fetch system errors (ETIMEDOUT, ECONNRESET, socket hang up, DNS)
 *                     or AbortError (deadline expiration)
 * Content error:      400 with "can't parse entities" or similar parse failure
 * Permanent:          403, 404, "method not found", bad draft_id
 * Unknown:            anything else (safe fallback: treat as transient)
 */
export function classifyDraftError(err: unknown): DraftErrorClass {
  // TelegramError from telegraf (has response.error_code)
  const tgErr = err as any;
  if (tgErr?.response?.error_code) {
    const code = tgErr.response.error_code;
    const description = (tgErr.response.description || "").toLowerCase();

    if (code === 429) {
      // Rate limited — extract retry_after
      const retryAfter =
        tgErr.response.parameters?.retry_after ??
        tgErr.parameters?.retry_after ??
        3; // default 3s if not specified
      return { type: "rate_limited", retryAfter: Math.max(1, retryAfter), original: err };
    }

    if (code === 400) {
      // Content error if parse-related (retry once as plain text)
      if (
        description.includes("can't parse entities") ||
        description.includes("entity") ||
        description.includes("parse") ||
        description.includes("unable to parse")
      ) {
        return { type: "content_error", original: err };
      }
      // "Bad Request: method not found" or similar → permanent
      // Chat/auth-level errors ("chat not found", "not enough rights", "kicked",
      // "deactivated") are non-retryable → permanent (per review 1407108)
      if (
        description.includes("method not found") ||
        description.includes("method is not available") ||
        description.includes("not supported") ||
        description.includes("draft_id") ||
        description.includes("chat not found") ||
        description.includes("not enough rights") ||
        description.includes("kicked") ||
        description.includes("deactivated") ||
        description.includes("bot was blocked") ||
        description.includes("group chat was deactivated")
      ) {
        return { type: "permanent_disable", original: err };
      }
      // Other 400s — conservative: treat as content error to avoid permanent disable
      return { type: "content_error", original: err };
    }

    // 401 (invalid token) is a permanent, non-retryable condition.
    if (code === 401 || code === 403 || code === 404) {
      return { type: "permanent_disable", original: err };
    }

    // Other HTTP errors (5xx etc) — transient
    return { type: "transient_network", original: err };
  }

  // FetchError or TypeError from node-fetch / native fetch
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    // AbortError from AbortController
    if (err.name === "AbortError" || msg.includes("abort") || msg.includes("the operation was aborted")) {
      return { type: "transient_network", original: err };
    }

    // node-fetch system errors
    const fetchErr = err as any;
    if (
      fetchErr.type === "system" ||
      fetchErr.code === "ETIMEDOUT" ||
      fetchErr.code === "ECONNRESET" ||
      fetchErr.code === "ECONNREFUSED" ||
      fetchErr.code === "ENOTFOUND" ||
      fetchErr.code === "EPIPE" ||
      fetchErr.errno === "ETIMEDOUT" ||
      fetchErr.errno === "ECONNRESET" ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("fetch failed") ||
      msg.includes("socket hang up") ||
      msg.includes("network error") ||
      msg.includes("request timed out") ||
      msg.includes("reason:")
    ) {
      return { type: "transient_network", original: err };
    }

    // Generic Error with no special classification — be safe, treat as transient
    return { type: "transient_network", original: err };
  }

  // Non-Error throw (unusual)
  return { type: "unknown", original: err };
}

// ---------------------------------------------------------------------------
// Per-chat cooldown state (module-scoped, survives across DraftStreamer instances)
// ---------------------------------------------------------------------------

interface CooldownState {
  until: number; // epoch ms
}

const chatCooldowns = new Map<string, CooldownState>();

/**
 * Export for testing: allows tests to inspect/inject cooldown state.
 */
export function _getChatCooldowns(): Map<string, CooldownState> {
  return chatCooldowns;
}

/**
 * Export for testing: allows tests to reset cooldown state between test runs.
 */
export function _resetChatCooldowns(): void {
  chatCooldowns.clear();
}

// ---------------------------------------------------------------------------
// Token redaction helper
// ---------------------------------------------------------------------------

/**
 * Redact Telegram bot tokens from strings (URLs, error messages).
 * Matches /bot<number>:<token>/ or /user<number>:<token>/ patterns.
 */
function redactToken(text: string): string {
  return text.replace(/\/(bot|user)(\d+):[^/]+\//g, "/$1$2:[REDACTED]/");
}

// ---------------------------------------------------------------------------
// DraftStreamer
// ---------------------------------------------------------------------------

/**
 * Optional constructor overrides. All are test seams — production defaults are
 * the static constants below. No production call site passes these.
 */
export interface DraftStreamerOptions {
  /** Per-flush abort deadline in ms (default 5000). */
  draftDeadlineMs?: number;
  /** Minimum gap between flushes in ms (default 1000). */
  throttleMs?: number;
  /** Per-turn flush cap (default 30). */
  maxFlushesPerTurn?: number;
  /** Consecutive transient errors before soft-stop (default 5). */
  transientLimit?: number;
  /** Max time finalize paths wait for an in-flight draft to settle (default 1000). */
  finalizeSettleMs?: number;
}

/**
 * Manages throttled Telegram draft message updates.
 * Uses `sendMessageDraft` to show partial streamed text to the user
 * as it arrives, then gets replaced by the final formatted message.
 *
 * Error handling (per streaming-fix architecture):
 * - 429: honor retry_after, per-chat cooldown survives across turns
 * - Transient network: skip/retry once (next flush carries full text, lossless)
 * - Content 400: retry raw text once
 * - 401/403/404/bad-draft_id/chat-level 400: disable for the turn
 *
 * Finalization (fix A): stop() aborts any in-flight draft so a stale partial
 * draft can never land AFTER the final sendMessage, and finalize paths settle
 * the in-flight promise under a short deadline before sending.
 */
export class DraftStreamer {
  private draftId: number;
  private lastSentText: string = "";
  private pendingText: string = "";
  private lastSendTime: number = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private disabled: boolean = false;
  private finalized: boolean = false;
  /** True after stop(): no further drafts may be sent (finalize in progress). */
  private stopped: boolean = false;

  /** Promise tracking the current in-flight flush (for serialization) */
  private inFlightPromise: Promise<void> | null = null;
  /** AbortController of the current in-flight flush — stored so stop() can abort it */
  private inFlightAbortController: AbortController | null = null;
  /** If true, schedule one follow-up flush after the current in-flight one completes */
  private coalesceAfterFlush: boolean = false;

  /** Number of flushes sent this turn (capped by maxFlushesPerTurn) */
  private flushCountThisTurn: number = 0;
  /** Consecutive transient- or content-error failures (soft-stop at limit) */
  private consecutiveTransients: number = 0;

  private static readonly THROTTLE_MS = 1000;         // raised from 300ms per plan §3.2
  private static readonly MIN_CHARS_DELTA = 40;        // unchanged
  private static readonly MAX_FLUSHES_PER_TURN = 30;   // hard cap per §3.2
  private static readonly DRAFT_DEADLINE_MS = 5000;    // 5s abort deadline per §3.3
  private static readonly TRANSIENT_LIMIT = 5;         // consecutive transients → soft-stop
  private static readonly FINALIZE_SETTLE_MS = 1000;   // max wait for in-flight draft at finalize
  private static readonly COOLDOWN_JITTER_MS = 1000;   // 429 cooldown jitter to avoid lockstep retries

  private readonly opts: DraftStreamerOptions;

  constructor(
    private bot: Telegraf,
    private chatId: string | number,
    opts: DraftStreamerOptions = {}
  ) {
    this.opts = opts;
    // Use a stable draft_id derived from the chat ID so Telegram always
    // updates the same draft bubble across turns (avoids "Deleted message" artifacts).
    // Must be a positive 32-bit integer.
    const id = typeof chatId === "string" ? parseInt(chatId, 10) : chatId;
    this.draftId = Math.abs(id % 2147483647) || 1;
  }

  /** Per-flush abort deadline (ms). Injectable for tests. */
  private get draftDeadlineMs(): number {
    return this.opts.draftDeadlineMs ?? DraftStreamer.DRAFT_DEADLINE_MS;
  }
  /** Minimum gap between flushes (ms). Injectable for tests. */
  private get throttleMs(): number {
    return this.opts.throttleMs ?? DraftStreamer.THROTTLE_MS;
  }
  /** Per-turn flush cap. Injectable for tests. */
  private get maxFlushesPerTurn(): number {
    return this.opts.maxFlushesPerTurn ?? DraftStreamer.MAX_FLUSHES_PER_TURN;
  }
  /** Consecutive transient soft-stop limit. Injectable for tests. */
  private get transientLimit(): number {
    return this.opts.transientLimit ?? DraftStreamer.TRANSIENT_LIMIT;
  }
  /** Max wait for in-flight draft to settle at finalize (ms). Injectable for tests. */
  private get finalizeSettleMs(): number {
    return this.opts.finalizeSettleMs ?? DraftStreamer.FINALIZE_SETTLE_MS;
  }

  /**
   * Return the string chat ID for cooldown lookups.
   */
  private get chatIdStr(): string {
    return String(this.chatId);
  }

  /**
   * Return true if this chat is currently in cooldown (429-based rate limiting).
   * Lazily prunes the expired entry so the module-level Map doesn't accumulate
   * dead rows (review 1407108).
   */
  private isInCooldown(): boolean {
    const cd = chatCooldowns.get(this.chatIdStr);
    if (cd === undefined) return false;
    if (Date.now() >= cd.until) {
      chatCooldowns.delete(this.chatIdStr);
      return false;
    }
    return true;
  }

  /**
   * Update the pending text. Triggers a flush if:
   * - Enough time has elapsed since last send (THROTTLE_MS), AND
   * - Enough new characters have accumulated (MIN_CHARS_DELTA)
   * No-op if already finalized.
   *
   * Synchronous and non-blocking (invariant I1 from the plan).
   */
  update(fullText: string): void {
    if (this.finalized || this.stopped) return;

    this.pendingText = fullText;

    // Check if we should flush immediately
    const now = Date.now();
    const timeSinceLastSend = now - this.lastSendTime;
    const charsDelta = fullText.length - this.lastSentText.length;

    if (timeSinceLastSend >= this.throttleMs && charsDelta >= DraftStreamer.MIN_CHARS_DELTA) {
      // Fire async — do not await (I1: update() stays sync)
      this.flush().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[draft] Flush failed: ${redactToken(msg)}`);
      });
    } else if (!this.flushTimer) {
      // Set a debounce timer to flush after throttleMs
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[draft] Debounced flush failed: ${redactToken(msg)}`);
        });
      }, this.throttleMs);
    }
  }

  /**
   * Stop the draft streamer. Clears any pending timer and aborts any in-flight
   * flush so a stale partial draft can never land AFTER the final sendMessage
   * (fix A). Marks the streamer as stopped, which suppresses the coalesced
   * follow-up and any later flush.
   *
   * Returns the in-flight promise (if any) so async finalize paths can settle
   * it under a short deadline before sending the final message.
   */
  stop(): Promise<void> | null {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Abort the in-flight draft request. If it already completed, this is a
    // no-op; if it is hung, the abort rejects it → transient → no stale draft.
    if (this.inFlightAbortController) {
      this.inFlightAbortController.abort();
    }
    return this.inFlightPromise;
  }

  /**
   * Wait (bounded) for an in-flight draft to settle after stop() aborted it.
   * Guarantees the final message is not sent while a draft could still land.
   */
  private async settleInFlight(inFlight: Promise<void> | null): Promise<void> {
    if (!inFlight) return;
    try {
      // inFlight never rejects (its internal .catch handles errors), but guard
      // defensively with a short deadline so finalization can't be blocked.
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => setTimeout(resolve, this.finalizeSettleMs)),
      ]);
    } catch {
      // Defensive — ignore; the abort already prevents a stale draft.
    }
  }

  /**
   * Clean finalization: send accumulated text as a real message without interruption suffix.
   * Sets finalized flag synchronously before async work.
   * If no accumulated text, does nothing.
   * Returns the Telegram message ID if successfully sent, null otherwise.
   * No-op if already finalized (returns null).
   */
  async finalizeClean(): Promise<number | null> {
    // Set flag synchronously BEFORE async work to prevent races
    if (this.finalized) return null;
    this.finalized = true;

    // Clear any pending flush timer + abort in-flight draft, then settle it
    // under a short deadline so a stale draft can't land after our message.
    const inFlight = this.stop();
    await this.settleInFlight(inFlight);

    const accumulatedText = this.pendingText || this.lastSentText;

    // If no text accumulated, nothing to send
    if (!accumulatedText) return null;

    // Try HTML first (like sendMessageSafe pattern)
    let text = accumulatedText;
    try {
      text = markdownToTelegramHtml(accumulatedText);
      try {
        const result = await this.bot.telegram.sendMessage(this.chatId, text, { parse_mode: "HTML" });
        return result.message_id;
      } catch {
        // HTML send failed, retry with plain text
        const result = await this.bot.telegram.sendMessage(this.chatId, accumulatedText);
        return result.message_id;
      }
    } catch (err) {
      // Markdown conversion failed, try plain text
      try {
        const result = await this.bot.telegram.sendMessage(this.chatId, accumulatedText);
        return result.message_id;
      } catch (e2) {
        console.warn("[draft] finalizeClean: Failed to send finalization message:", e2);
        return null;
      }
    }
  }

  /**
   * Finalize the draft as a real message (for graceful shutdown or interrupt).
   * If there's accumulated text, sends it with an interruption notice.
   * If no text, sends just the interruption notice.
   * Uses the same sendMessageSafe pattern as regular sends: try HTML, fall back to plain text on send failure.
   * suffix parameter allows custom interruption message (defaults to "restarting").
   * No-op if already finalized.
   */
  async finalize(suffix: string = "restarting"): Promise<void> {
    // Set flag synchronously BEFORE async work to prevent races
    if (this.finalized) return;
    this.finalized = true;

    // Clear any pending flush timer + abort in-flight draft, then settle it
    // under a short deadline so a stale draft can't land after our message.
    const inFlight = this.stop();
    await this.settleInFlight(inFlight);

    const accumulatedText = this.pendingText || this.lastSentText;

    // Build message: accumulated text + interruption notice
    let messageText = "";
    if (accumulatedText) {
      messageText = `${accumulatedText}\n\n⚠️ _Response interrupted — ${suffix}_`;
    } else {
      messageText = `⚠️ _Response interrupted — ${suffix}_`;
    }

    // Try HTML first (like sendMessageSafe pattern)
    let text = messageText;
    try {
      text = markdownToTelegramHtml(messageText);
      try {
        await this.bot.telegram.sendMessage(this.chatId, text, { parse_mode: "HTML" });
        return;
      } catch {
        // HTML send failed, retry with plain text
        await this.bot.telegram.sendMessage(this.chatId, messageText);
      }
    } catch (err) {
      // Markdown conversion failed, try plain text
      try {
        await this.bot.telegram.sendMessage(this.chatId, messageText);
      } catch (e2) {
        console.warn("[draft] finalize: Failed to send finalization message:", e2);
      }
    }
  }

  /**
   * Actually send the draft to Telegram.
   * Handles serialization, coalescing, deadlines, error classification,
   * cooldown, per-turn cap, and content-error retry.
   */
  private async flush(): Promise<void> {
    // ── Guard checks (synchronous) ──
    if (this.disabled) return;
    if (this.finalized) return;
    if (this.stopped) return;
    if (this.pendingText === this.lastSentText) return;
    if (this.pendingText.length === 0) return;

    // Per-turn cap (I9)
    if (this.flushCountThisTurn >= this.maxFlushesPerTurn) {
      if (this.flushCountThisTurn === this.maxFlushesPerTurn) {
        this.flushCountThisTurn++; // log only once
        console.warn(`[draft] Per-turn cap (${this.maxFlushesPerTurn}) reached for chat=${this.chatId}`);
      }
      return;
    }

    // Shared cooldown check (across turns via module-level Map)
    if (this.isInCooldown()) {
      return;
    }

    // ── Serialization / coalescing (I7) ──
    if (this.inFlightPromise) {
      // A flush is already in flight. Don't queue — coalesce: just remember
      // that new text arrived so we send exactly one follow-up after this
      // one settles with the latest pendingText.
      this.coalesceAfterFlush = true;
      return;
    }

    // ── Prepare the draft payload ──
    const textToSend = this.pendingText;
    this.lastSentText = textToSend;
    this.lastSendTime = Date.now();
    this.flushCountThisTurn++;

    // Try to convert markdown to Telegram HTML for rich-text drafts.
    // If conversion throws (e.g. malformed partial markdown), fall back to raw text.
    let draftText: string;
    let parseMode: string | undefined;

    try {
      draftText = markdownToTelegramHtml(textToSend);
      parseMode = "HTML";
    } catch {
      draftText = textToSend;
      parseMode = undefined;
    }

    // ── Deadline (AbortSignal, §3.3) ──
    const abortController = new AbortController();
    // Store on `this` so stop() can abort the in-flight draft (fix A).
    this.inFlightAbortController = abortController;
    const deadlineTimer = setTimeout(() => {
      abortController.abort();
    }, this.draftDeadlineMs);

    // ── Build the promise chain (set inFlightPromise BEFORE first await) ──
    const flushPromise = this.executeDraftSend(draftText, textToSend, parseMode, abortController)
      .then(() => {
        // Success: reset transient counter
        this.consecutiveTransients = 0;
      })
      .catch((err: unknown) => {
        this.handleFlushError(err);
      })
      .finally(() => {
        clearTimeout(deadlineTimer);
        if (this.inFlightAbortController === abortController) {
          this.inFlightAbortController = null;
        }
        this.inFlightPromise = null;

        // Coalesced follow-up: if new text arrived while we were sending,
        // fire exactly one more flush with the latest pendingText — but only
        // if the streamer hasn't been stopped/finalized since (fix A).
        if (this.coalesceAfterFlush && !this.finalized && !this.stopped && !this.disabled) {
          this.coalesceAfterFlush = false;
          // Use setTimeout to avoid synchronous stack buildup
          setTimeout(() => {
            this.flush().catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn(`[draft] Coalesced flush failed: ${redactToken(msg)}`);
            });
          }, 0);
        }
      });

    // Set in-flight marker BEFORE any async work completes (I7)
    this.inFlightPromise = flushPromise;
  }

  /**
   * Execute the actual callApi for sendMessageDraft.
   * On content error (400 parse failure), retries once as plain text.
   */
  private async executeDraftSend(
    draftText: string,
    rawText: string,
    parseMode: string | undefined,
    abortController: AbortController
  ): Promise<void> {
    const params: Record<string, unknown> = {
      chat_id: this.chatId,
      draft_id: this.draftId,
      text: draftText,
    };

    // First attempt: with parse_mode if available
    if (parseMode) {
      params.parse_mode = parseMode;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.bot.telegram as any).callApi("sendMessageDraft", params, {
        signal: abortController.signal,
      });
      return;
    } catch (firstErr) {
      // Check if this is a content error and we should retry as plain text
      const classification = classifyDraftError(firstErr);
      if (classification.type === "content_error" && parseMode) {
        // Retry once without parse_mode
        console.warn(`[draft] Content error — retrying as plain text: ${formatErrorForLog(firstErr)}`);
        const retryParams: Record<string, unknown> = {
          chat_id: this.chatId,
          draft_id: this.draftId,
          text: rawText, // use original markdown text
        };
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (this.bot.telegram as any).callApi("sendMessageDraft", retryParams, {
            signal: abortController.signal,
          });
          return; // retry succeeded
        } catch (retryErr) {
          // Retry also failed — re-throw the original error for classification
          throw retryErr;
        }
      }
      // Re-throw for handleFlushError
      throw firstErr;
    }
  }

  /**
   * Handle a flush error by classification.
   * Must not throw (catches all errors internally).
   */
  private handleFlushError(err: unknown): void {
    const classification = classifyDraftError(err);

    // Get a safe string for logging (token-redacted)
    const errStr = formatErrorForLog(err);

    switch (classification.type) {
      case "rate_limited": {
        console.warn(
          `[draft] Rate limited (429) — cooldown ${classification.retryAfter}s for chat=${this.chatId}: ${errStr}`
        );
        // Set per-chat cooldown (survives across DraftStreamer instances).
        // Add jitter so chats sharing a global limit don't retry in lockstep.
        const jitter = Math.floor(Math.random() * DraftStreamer.COOLDOWN_JITTER_MS);
        const until = Date.now() + classification.retryAfter * 1000 + jitter;
        chatCooldowns.set(this.chatIdStr, { until });
        // Reset lastSentText so the next flush carries full text (lossless)
        this.lastSentText = "";
        break;
      }

      case "transient_network": {
        this.consecutiveTransients++;
        console.warn(
          `[draft] Transient network error (${this.consecutiveTransients}/${this.transientLimit}) for chat=${this.chatId}: ${errStr}`
        );
        // Reset lastSentText so the next flush carries full text (lossless)
        this.lastSentText = "";
        if (this.consecutiveTransients >= this.transientLimit) {
          this.disabled = true;
          console.warn(
            `[draft] ${this.consecutiveTransients} consecutive transient errors — soft-stopping drafts for chat=${this.chatId} (this turn)`
          );
        }
        break;
      }

      case "content_error": {
        console.warn(
          `[draft] Content error — raw retry result for chat=${this.chatId}: ${errStr}`
        );
        // We already attempted the raw-text retry in executeDraftSend.
        // If it also failed, treat as transient (skip, lossless).
        this.lastSentText = "";
        this.consecutiveTransients++;
        if (this.consecutiveTransients >= this.transientLimit) {
          this.disabled = true;
          console.warn(
            `[draft] ${this.consecutiveTransients} consecutive errors — soft-stopping drafts for chat=${this.chatId} (this turn)`
          );
        }
        break;
      }

      case "permanent_disable": {
        console.warn(
          `[draft] Permanent error — disabling drafts for chat=${this.chatId} (this turn): ${errStr}`
        );
        this.disabled = true;
        break;
      }

      default: {
        // Unknown: safe default, treat as transient
        console.warn(
          `[draft] Unknown error — treating as transient for chat=${this.chatId}: ${errStr}`
        );
        this.lastSentText = "";
        this.consecutiveTransients++;
        if (this.consecutiveTransients >= this.transientLimit) {
          this.disabled = true;
        }
        break;
      }
    }
  }
}

/**
 * Format an error for logging: redact tokens from the message string.
 */
function formatErrorForLog(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactToken(msg).slice(0, 300);
}