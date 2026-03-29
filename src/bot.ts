import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { initSession, loadHistory, saveMessage } from "./session.js";
import { runAgent, extractTextFromResponse } from "./agent.js";
import type { Message } from "./types.js";

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
      // Send typing indicator
      await ctx.sendChatAction("typing");

      // Run agent loop
      const newMessages = await runAgent(history);

      // Save all new messages
      for (const msg of newMessages) {
        saveMessage(chatId, msg);
      }

      // Extract and send reply
      const reply = extractTextFromResponse(newMessages);

      // Telegram has a 4096 char limit per message
      if (reply.length <= 4096) {
        await ctx.reply(reply);
      } else {
        // Split into chunks
        for (let i = 0; i < reply.length; i += 4096) {
          await ctx.reply(reply.slice(i, i + 4096));
        }
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
