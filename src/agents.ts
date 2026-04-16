import path from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { config } from "./config.js";

export interface AgentDef {
  name: string;
  model: string;
  workspaceDir: string;
  description: string; // from SUBAGENT.md frontmatter — used for routing
  systemPrompt: string; // body of SUBAGENT.md (below frontmatter)
  thinking?: boolean; // enable extended thinking for this agent
}

interface SubagentFrontmatter {
  name?: string;
  description?: string;
  model?: string;
}

interface ParsedSubagent {
  definition: AgentDef;
  sourcePath: string;
}

/**
 * Parse YAML-style frontmatter from a markdown file.
 * Returns { frontmatter, body }.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    frontmatter[key] = value;
  }

  return { frontmatter, body: match[2].trim() };
}

export function getAgentsDir(): string {
  return path.join(config.workspace, "agents");
}

export function getSubagentSetupHint(): string {
  const agentsDir = getAgentsDir();
  return `Create ${agentsDir}/<name>/SUBAGENT.md with frontmatter like: --- name: reviewer description: Reviews code changes model: ${config.claudeModel} ---`;
}

function loadAgentFiles(): ParsedSubagent[] {
  const agentsDir = getAgentsDir();
  const parsed: ParsedSubagent[] = [];

  if (!existsSync(agentsDir)) return parsed;

  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const agentDir = path.join(agentsDir, entry.name);
    const subagentPath = path.join(agentDir, "SUBAGENT.md");

    if (!existsSync(subagentPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(subagentPath, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[agents] Failed to read ${subagentPath}: ${message} — skipping`);
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(raw);

    const name = frontmatter.name || entry.name;
    const description = frontmatter.description;

    if (!description) {
      console.warn(`[agents] ${subagentPath} is missing required 'description' frontmatter — skipping`);
      continue;
    }

    // Parse thinking flag (frontmatter values are strings, treat "true" as truthy)
    const thinking = frontmatter.thinking === "true";

    parsed.push({
      sourcePath: subagentPath,
      definition: {
        name,
        model: frontmatter.model || config.claudeModel,
        workspaceDir: agentDir,
        description,
        systemPrompt: body,
        thinking: thinking || undefined,
      },
    });
  }

  return parsed;
}

export function listAgentDefs(): AgentDef[] {
  const parsed = loadAgentFiles();
  const duplicateNames = new Set<string>();
  const unique = new Map<string, ParsedSubagent>();

  for (const entry of parsed) {
    const existing = unique.get(entry.definition.name);
    if (existing) {
      duplicateNames.add(entry.definition.name);
      console.warn(
        `[agents] Duplicate subagent name "${entry.definition.name}" in ${existing.sourcePath} and ${entry.sourcePath} — excluding both`,
      );
      unique.delete(entry.definition.name);
      continue;
    }

    if (duplicateNames.has(entry.definition.name)) {
      console.warn(
        `[agents] Duplicate subagent name "${entry.definition.name}" in ${entry.sourcePath} — excluding`,
      );
      continue;
    }

    unique.set(entry.definition.name, entry);
  }

  const agents = Array.from(unique.values()).map((entry) => entry.definition);
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}

export function listAgentNames(): string[] {
  return listAgentDefs().map((agent) => agent.name);
}

export function getAgentDef(name: string): AgentDef | undefined {
  return listAgentDefs().find((agent) => agent.name === name);
}

/**
 * Build a subagents summary block for injection into the main agent's system prompt.
 * Lists each subagent name + description so the main agent can route intelligently.
 */
export function buildSubagentsSummary(): string {
  const subagents = listAgentDefs();
  if (subagents.length === 0) return "";

  const lines = subagents.map((a) => `- **${a.name}**: ${a.description}`);
  return `[Available Subagents]\n\n${lines.join("\n")}`;
}


export function resetAgentsCache(): void {
  // No-op: upstream version does not cache agent defs
}
