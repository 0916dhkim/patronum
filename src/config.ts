import "dotenv/config";

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  claudeToken: requireEnv("CLAUDE_TOKEN"),
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  workspace: process.env.WORKSPACE || process.cwd(),
};

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
