import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";

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
  // Workspace is always the directory containing patronum.toml
  // Search upward from cwd, or use WORKSPACE env var as override
  const workspace = findWorkspace();
  config.workspace = workspace;

  const tomlPath = path.join(workspace, "patronum.toml");
  if (!existsSync(tomlPath)) {
    throw new Error(`patronum.toml not found at ${tomlPath}`);
  }

  const raw = readFileSync(tomlPath, "utf-8");
  const toml = parse(raw) as Record<string, unknown>;

  const patronum = (toml.patronum ?? {}) as Record<string, unknown>;
  const credentials = (toml.credentials ?? {}) as Record<string, unknown>;

  config.claudeModel = str(patronum.model) || "claude-sonnet-4-6";
  config.ownerChatId = str(patronum.owner_chat_id) || "";

  config.claudeToken = str(credentials.claude_token) || requireEnv("CLAUDE_TOKEN");
  config.telegramBotToken = str(credentials.telegram_bot_token) || requireEnv("TELEGRAM_BOT_TOKEN");
  config.voyageApiKey = str(credentials.voyage_api_key) || process.env.VOYAGE_API_KEY || "";
}

function findWorkspace(): string {
  // Allow explicit override via env var
  if (process.env.WORKSPACE) return process.env.WORKSPACE;

  // Walk upward from cwd looking for patronum.toml
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "patronum.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fall back to cwd
  return process.cwd();
}

function str(val: unknown): string {
  return typeof val === "string" ? val : "";
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required config: ${key} (not in patronum.toml and not in environment)`);
  }
  return value;
}

// Export agent overrides so agents.ts can use them
export function getAgentOverrides(): Record<string, { model?: string }> {
  const workspace = config.workspace || findWorkspace();
  const tomlPath = path.join(workspace, "patronum.toml");
  if (!existsSync(tomlPath)) return {};

  const raw = readFileSync(tomlPath, "utf-8");
  const toml = parse(raw) as Record<string, unknown>;
  return ((toml.agents ?? {}) as Record<string, { model?: string }>);
}
