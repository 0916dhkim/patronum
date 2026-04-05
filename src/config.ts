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
  vaultwardenUrl: string;
  vaultwardenEmail: string;
  vaultwardenMasterPassword: string;
  searxngToken: string;
}

// Mutable config — populated by initConfig() before use
export const config: Config = {
  telegramBotToken: "",
  claudeToken: "",
  claudeModel: "",
  workspace: "",
  ownerChatId: "",
  voyageApiKey: "",
  vaultwardenUrl: "",
  vaultwardenEmail: "",
  vaultwardenMasterPassword: "",
  searxngToken: "",
};

export async function initConfig(): Promise<void> {
  const workspace = findWorkspace();
  config.workspace = workspace;

  const { tomlPath, data } = loadPatronumToml(workspace);
  const patronum = getOptionalTable(data, "patronum", tomlPath) ?? {};
  const credentials = getRequiredTable(data, "credentials", tomlPath);

  config.claudeModel = getOptionalString(patronum, "patronum.model", "model", tomlPath) ?? "claude-sonnet-4-6";
  config.ownerChatId = getOptionalString(patronum, "patronum.owner_chat_id", "owner_chat_id", tomlPath) ?? "";
  config.claudeToken = getRequiredString(credentials, "credentials.claude_token", "claude_token", tomlPath);
  config.telegramBotToken = getRequiredString(credentials, "credentials.telegram_bot_token", "telegram_bot_token", tomlPath);
  config.voyageApiKey = getOptionalString(credentials, "credentials.voyage_api_key", "voyage_api_key", tomlPath) ?? "";

  const vaultwarden = getOptionalTable(data, "vaultwarden", tomlPath) ?? {};
  config.vaultwardenUrl = getOptionalString(vaultwarden, "vaultwarden.url", "url", tomlPath) ?? "";
  config.vaultwardenEmail = getOptionalString(vaultwarden, "vaultwarden.email", "email", tomlPath) ?? "";
  config.vaultwardenMasterPassword = getOptionalString(vaultwarden, "vaultwarden.master_password", "master_password", tomlPath) ?? "";

  const searxng = getOptionalTable(data, "searxng", tomlPath) ?? {};
  // Allow empty token for searxng — it's optional and Danny can fill it in later
  const tokenValue = searxng.token;
  config.searxngToken = typeof tokenValue === "string" ? tokenValue : "";
}

function findWorkspace(): string {
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

function loadPatronumToml(workspace: string): {
  tomlPath: string;
  data: Record<string, unknown>;
} {
  const tomlPath = path.join(workspace, "patronum.toml");
  if (!existsSync(tomlPath)) {
    throw new Error(`Missing required config file: ${tomlPath}`);
  }

  const raw = readFileSync(tomlPath, "utf-8");

  try {
    const parsed = parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(`Invalid config root in ${tomlPath}: expected table`);
    }
    return { tomlPath, data: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${tomlPath}: ${message}`);
  }
}

function getRequiredTable(
  root: Record<string, unknown>,
  key: string,
  tomlPath: string,
): Record<string, unknown> {
  if (!(key in root)) {
    throw new Error(`Missing required config section: ${key} in ${tomlPath}`);
  }

  const value = root[key];
  if (!isRecord(value)) {
    throw new Error(`Invalid config at ${key} in ${tomlPath}: expected table`);
  }

  return value;
}

function getOptionalTable(
  root: Record<string, unknown>,
  key: string,
  tomlPath: string,
): Record<string, unknown> | undefined {
  if (!(key in root)) return undefined;

  const value = root[key];
  if (!isRecord(value)) {
    throw new Error(`Invalid config at ${key} in ${tomlPath}: expected table`);
  }

  return value;
}

function getRequiredString(
  table: Record<string, unknown>,
  pathKey: string,
  key: string,
  tomlPath: string,
): string {
  if (!(key in table)) {
    throw new Error(`Missing required config: ${pathKey} in ${tomlPath}`);
  }

  return getValidatedString(table[key], pathKey, tomlPath);
}

function getOptionalString(
  table: Record<string, unknown>,
  pathKey: string,
  key: string,
  tomlPath: string,
): string | undefined {
  if (!(key in table)) return undefined;

  return getValidatedString(table[key], pathKey, tomlPath);
}

function getValidatedString(value: unknown, pathKey: string, tomlPath: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid config at ${pathKey} in ${tomlPath}: expected string`);
  }

  if (value.trim() === "") {
    throw new Error(`Invalid config at ${pathKey} in ${tomlPath}: value must not be empty`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Export agent overrides so agents.ts can use them
export function getAgentOverrides(): Record<string, { model?: string }> {
  const workspace = config.workspace || findWorkspace();
  const { tomlPath, data } = loadPatronumToml(workspace);
  return (getOptionalTable(data, "agents", tomlPath) ?? {}) as Record<string, { model?: string }>;
}
