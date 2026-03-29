import { createReadStream, existsSync } from "fs";
import { basename, extname } from "path";
import type { Telegraf } from "telegraf";
import type { ToolHandler } from "../types.js";

// Bot instance — set from bot.ts after creation
let bot: Telegraf | null = null;

export function setBot(b: Telegraf): void {
  bot = b;
}

export function getBot(): Telegraf | null {
  return bot;
}

// Chat ID — set before tool execution (re-exported via index.ts)
let currentChatId: string = "";

export function setSendMediaChatId(chatId: string): void {
  currentChatId = chatId;
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

export const sendMediaTool: ToolHandler = {
  definition: {
    name: "send_media",
    description:
      "Send a file (image, screenshot, document) to the user via Telegram. Use this to deliver screenshots, generated files, or any media output.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to send",
        },
        caption: {
          type: "string",
          description: "Optional caption for the file",
        },
      },
      required: ["path"],
    },
  },

  async execute(input): Promise<string> {
    const filePath = input.path as string;
    const caption = (input.caption as string) || undefined;

    if (!bot) {
      return "Error: Bot instance not available";
    }
    if (!currentChatId) {
      return "Error: No chat context available";
    }
    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    const ext = extname(filePath).toLowerCase();
    const filename = basename(filePath);

    try {
      if (IMAGE_EXTS.has(ext)) {
        await bot.telegram.sendPhoto(
          currentChatId,
          { source: createReadStream(filePath), filename },
          { caption }
        );
      } else {
        await bot.telegram.sendDocument(
          currentChatId,
          { source: createReadStream(filePath), filename },
          { caption }
        );
      }

      console.log(`[send_media] Sent ${filename} to chat=${currentChatId}`);
      return `Sent ${filename} to chat`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[send_media] Failed:`, msg);
      return `Error sending file: ${msg}`;
    }
  },
};
