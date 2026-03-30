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

  private static readonly THROTTLE_MS = 300;
  private static readonly MIN_CHARS_DELTA = 40;

  constructor(
    private bot: Telegraf,
    private chatId: string | number
  ) {
    // Use a random positive integer as draft_id (Telegram requires non-zero)
    this.draftId = Math.floor(Math.random() * 2147483647) + 1;
  }

  /**
   * Update the pending text. Triggers a flush if:
   * - Enough time has elapsed since last send (THROTTLE_MS), OR
   * - Enough new characters have accumulated (MIN_CHARS_DELTA)
   */
  update(fullText: string): void {
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
