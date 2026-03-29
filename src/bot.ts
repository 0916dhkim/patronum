import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { initSession, loadHistory, saveMessage, replaceHistory } from "./session.js";
import { initThread, appendToThread, loadThread, formatThreadForContext, compactThread } from "./thread.js";
import { runAgent, extractTextFromResponse, type AgentResult } from "./agent.js";
import { compactIfNeeded } from "./compaction.js";
import { markdownToTelegramHtml } from "./format.js";
import { setCurrentChatId } from "./tools/index.js";
import { AGENTS } from "./agents.js";
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
  initThread();

  const bot = new Telegraf(config.telegramBotToken, {
    handlerTimeout: Infinity, // no timeout — personal bot, multi-agent flows can run as long as needed
  });
  const linAgent = AGENTS.lin;

  const BOT_START_TIME = Math.floor(Date.now() / 1000);

  bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userText = ctx.message.text;
    const msgTime = ctx.message.date; // Unix timestamp

    // Drop messages that arrived before the bot started (stale replay)
    if (msgTime < BOT_START_TIME - 5) {
      console.log(`[msg] dropped stale message (age=${BOT_START_TIME - msgTime}s): ${userText.slice(0, 50)}`);
      return;
    }

    console.log(`[msg] chat=${chatId}: ${userText.slice(0, 100)}`);

    // Set chat ID so run_agent tool knows the current context
    setCurrentChatId(chatId);

    // --- Thread: append user message ---
    appendToThread(chatId, "user", userText);

    // Auto-compact thread before running Lin
    try {
      const didCompact = await compactThread(chatId);
      if (didCompact) {
        console.log(`[bot] Thread compacted for chat=${chatId}`);
      }
    } catch (err) {
      console.error(`[bot] Thread compaction failed (continuing):`, err);
    }

    // --- Legacy session history (kept for compaction compatibility) ---
    const history = loadHistory(chatId);
    const userMessage: Message = { role: "user", content: userText };
    history.push(userMessage);
    saveMessage(chatId, userMessage);

    try {
      // Show typing indicator while processing
      await ctx.sendChatAction("typing");

      // Load thread context for Lin
      const thread = loadThread(chatId);
      const threadContext = formatThreadForContext(thread);

      // Run Lin with thread context injected into system prompt
      const agentResult = await runAgent(history, {
        model: linAgent.model,
        workspace: linAgent.workspaceDir,
        extraContext: [threadContext],
      });

      const { messages: newMessages, inputTokens } = agentResult;

      // Save all new messages to session history
      for (const msg of newMessages) {
        saveMessage(chatId, msg);
      }

      // Token-based compaction: check if we've hit 70% of context window
      const model = linAgent.model;
      const { messages: compactedHistory, compacted } = await compactIfNeeded(
        [...history, ...newMessages],
        inputTokens,
        model
      );
      if (compacted) {
        replaceHistory(chatId, compactedHistory);
        history.splice(0, history.length, ...compactedHistory);
      }

      // Extract reply text
      const reply = extractTextFromResponse(newMessages);

      // Append Lin's response to the shared thread
      appendToThread(chatId, "lin", reply);

      // Send to Telegram
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

  bot.launch({ allowedUpdates: ["message"] });
  console.log("[patronum] Bot started (multi-agent mode)");

  // Send startup notification
  if (config.ownerChatId) {
    bot.telegram.sendMessage(config.ownerChatId, "🟢 Patronum online").catch((err) => {
      console.error("[patronum] Failed to send startup notification:", err);
    });
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[patronum] Received ${signal}, shutting down...`);
    if (config.ownerChatId) {
      try {
        await bot.telegram.sendMessage(config.ownerChatId, "🔴 Patronum offline");
      } catch (err) {
        console.error("[patronum] Failed to send shutdown notification:", err);
      }
    }
    bot.stop(signal);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
