import "dotenv/config";
import { loadSecrets } from "./secrets.js";

export interface Config {
  telegramBotToken: string;
  claudeToken: string;
  claudeModel: string;
  workspace: string;
  ownerChatId: string;
  voyageApiKey: string;
}

// Mutable config — populated by initConfig() before use
export const config: Config = {
  telegramBotToken: "",
  claudeToken: "",
  claudeModel: "",
  workspace: "",
  ownerChatId: "",
  voyageApiKey: "",
};

export async function initConfig(): Promise<void> {
  // Try Secret Party first, fall back to env vars
  if (process.env.SECRET_PARTY_API_URL) {
    const secrets = await loadSecrets();
    config.claudeToken = secrets.claudeToken;
    config.telegramBotToken = secrets.telegramBotToken;
  } else {
    config.claudeToken = requireEnv("CLAUDE_TOKEN");
    config.telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  }

  config.claudeModel = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  config.workspace = process.env.WORKSPACE || process.cwd();
  config.ownerChatId = process.env.OWNER_CHAT_ID || "";
  config.voyageApiKey = process.env.VOYAGE_API_KEY || "";
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
