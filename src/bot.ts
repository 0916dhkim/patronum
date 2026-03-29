import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { initSession, loadHistory, saveMessage } from "./session.js";
import { runAgent, extractTextFromResponse } from "./agent.js";
import { markdownToTelegramHtml } from "./format.js";
import type { Message } from "./types.js";

const TELEGRAM_MSG_LIMIT = 4096;

/**
 * Split text into chunks respecting Telegram's 4096 char limit.
 * Tries to split on newlines for cleaner breaks.
 */
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MSG_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MSG_LIMIT);
    if (splitAt < TELEGRAM_MSG_LIMIT * 0.5) {
      // No good newline break, just split at limit
      splitAt = TELEGRAM_MSG_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

/**
 * Send text with parse_mode: "HTML", falling back to plain text on failure.
 */
async function editMessageSafe(
  bot: Telegraf,
  chatId: number | string,
  messageId: number,
  text: string
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  try {
    await bot.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      html,
      { parse_mode: "HTML" }
    );
  } catch {
    // HTML parse failed — retry as plain text
    try {
      await bot.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        text
      );
    } catch (e2) {
      console.error("[edit-fallback] Failed to edit message:", e2);
    }
  }
}

async function sendMessageSafe(
  bot: Telegraf,
  chatId: number | string,
  text: string
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  try {
    await bot.telegram.sendMessage(chatId, html, {
      parse_mode: "HTML",
    });
  } catch {
    // HTML parse failed — retry as plain text
    try {
      await bot.telegram.sendMessage(chatId, text);
    } catch (e2) {
      console.error("[send-fallback] Failed to send message:", e2);
    }
  }
}

export function startBot(): void {
  initSession();

  const bot = new Telegraf(config.telegramBotToken);

  bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userText = ctx.message.text;

    console.log(`[msg] chat=${chatId}: ${userText.slice(0, 100)}`);

    // Load history and add new user message
    const history = loadHistory(chatId);
    const userMessage: Message = { role: "user", content: userText };
    history.push(userMessage);
    saveMessage(chatId, userMessage);

    try {
      // Show typing indicator while processing
      await ctx.sendChatAction("typing");

      // Run agent loop
      const newMessages = await runAgent(history);

      // Save all new messages
      for (const msg of newMessages) {
        saveMessage(chatId, msg);
      }

      // Extract reply text and send
      const reply = extractTextFromResponse(newMessages);
      const chunks = splitMessage(reply);

      for (const chunk of chunks) {
        await sendMessageSafe(bot, ctx.chat.id, chunk);
      }
    } catch (err) {
      console.error("[error]", err);
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${msg.slice(0, 500)}`);
    }
  });

  bot.launch();
  console.log("[patronum] Bot started");

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
