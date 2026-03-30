import path from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { config } from "./config.js";

export interface AgentDef {
  name: string;
  model: string;
  workspaceDir: string;
  description: string; // from SUBAGENT.md frontmatter — used for routing
  systemPrompt: string; // body of SUBAGENT.md (below frontmatter)
}

interface SubagentFrontmatter {
  name?: string;
  description?: string;
  model?: string;
}

/**
 * Parse YAML-style frontmatter from a markdown file.
 * Returns { frontmatter, body }.
 */
function parseFrontmatter(content: string): { frontmatter: SubagentFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: SubagentFrontmatter = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    (frontmatter as Record<string, string>)[key] = value;
  }

  return { frontmatter, body: match[2].trim() };
}

function buildAgents(): Record<string, AgentDef> {
  const agentsDir = path.join(config.workspace, "agents");
  const agents: Record<string, AgentDef> = {};

  if (!existsSync(agentsDir)) return agents;

  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentDir = path.join(agentsDir, entry.name);
    const subagentPath = path.join(agentDir, "SUBAGENT.md");

    if (!existsSync(subagentPath)) continue;

    const raw = readFileSync(subagentPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    const name = frontmatter.name || entry.name;
    const description = frontmatter.description;

    if (!description) {
      console.warn(`[agents] ${name}/SUBAGENT.md is missing required 'description' frontmatter — skipping`);
      continue;
    }

    agents[name] = {
      name,
      model: frontmatter.model || config.claudeModel,
      workspaceDir: agentDir,
      description,
      systemPrompt: body,
    };
  }

  return agents;
}

// Lazy init — accessed after config is loaded
let _agents: Record<string, AgentDef> | null = null;

export const AGENTS = new Proxy({} as Record<string, AgentDef>, {
  get(_target, prop: string) {
    if (!_agents) _agents = buildAgents();
    return _agents[prop];
  },
  ownKeys() {
    if (!_agents) _agents = buildAgents();
    return Object.keys(_agents);
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    if (!_agents) _agents = buildAgents();
    if (prop in _agents) {
      return { configurable: true, enumerable: true, value: _agents[prop] };
    }
    return undefined;
  },
});

/**
 * Build a subagents summary block for injection into Lin's system prompt.
 * Lists each subagent name + description so Lin can route intelligently.
 */
export function buildSubagentsSummary(): string {
  if (!_agents) _agents = buildAgents();

  // Exclude lin itself
  const subagents = Object.values(_agents).filter((a) => a.name !== "lin");
  if (subagents.length === 0) return "";

  const lines = subagents.map((a) => `- **${a.name}**: ${a.description}`);
  return `[Available Subagents]\n\n${lines.join("\n")}`;
}
