import { Telegraf } from "telegraf";
import { markdownToTelegramHtml } from "./format.js";

/**
 * Manages throttled Telegram draft message updates.
 * Uses `sendMessageDraft` to show partial streamed text to the user
 * as it arrives, then gets replaced by the final formatted message.
 */
export class DraftStreamer {
  private draftId: number;
  private lastSentText: string = "";
  private pendingText: string = "";
  private lastSendTime: number = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private failed: boolean = false;
  private finalized: boolean = false;

  private static readonly THROTTLE_MS = 300;
  private static readonly MIN_CHARS_DELTA = 40;

  constructor(
    private bot: Telegraf,
    private chatId: string | number
  ) {
    // Use a stable draft_id derived from the chat ID so Telegram always
    // updates the same draft bubble across turns (avoids "Deleted message" artifacts).
    // Must be a positive 32-bit integer.
    const id = typeof chatId === "string" ? parseInt(chatId, 10) : chatId;
    this.draftId = Math.abs(id % 2147483647) || 1;
  }

  /**
   * Update the pending text. Triggers a flush if:
   * - Enough time has elapsed since last send (THROTTLE_MS), OR
   * - Enough new characters have accumulated (MIN_CHARS_DELTA)
   * No-op if already finalized.
   */
  update(fullText: string): void {
    if (this.finalized) return;

    this.pendingText = fullText;

    // Check if we should flush immediately
    const now = Date.now();
    const timeSinceLastSend = now - this.lastSendTime;
    const charsDelta = fullText.length - this.lastSentText.length;

    if (timeSinceLastSend >= DraftStreamer.THROTTLE_MS && charsDelta >= DraftStreamer.MIN_CHARS_DELTA) {
      this.flush().catch((err) => {
        console.warn("[draft] Flush failed:", err);
      });
    } else if (!this.flushTimer) {
      // Set a debounce timer to flush after THROTTLE_MS
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch((err) => {
          console.warn("[draft] Debounced flush failed:", err);
        });
      }, DraftStreamer.THROTTLE_MS);
    }
  }

  /**
   * Stop the draft streamer. Clears any pending timer.
   * Call this before sending the final message.
   */
  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
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

    this.stop(); // Clear any pending flush timer

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

    this.stop(); // Clear any pending flush timer

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
   * Converts markdown to Telegram HTML before sending.
   * Falls back to raw text if conversion fails on partial markdown.
   */
  private async flush(): Promise<void> {
    if (this.failed) return;
    if (this.pendingText === this.lastSentText) return;
    if (this.pendingText.length === 0) return;

    this.lastSentText = this.pendingText;
    this.lastSendTime = Date.now();

    // Try to convert markdown to Telegram HTML for rich-text drafts.
    // If conversion throws (e.g. malformed partial markdown), fall back to raw text.
    let text: string;
    let parseMode: string | undefined;

    try {
      text = markdownToTelegramHtml(this.pendingText);
      parseMode = "HTML";
    } catch {
      text = this.pendingText;
      parseMode = undefined;
    }

    try {
      const params: Record<string, unknown> = {
        chat_id: this.chatId,
        draft_id: this.draftId,
        text,
      };
      if (parseMode) {
        params.parse_mode = parseMode;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.bot.telegram as any).callApi("sendMessageDraft", params);
    } catch (err) {
      console.warn("[draft] sendMessageDraft not supported or failed, disabling:", err);
      this.failed = true;
    }
  }
}
