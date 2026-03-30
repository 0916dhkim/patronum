import path from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { config, getAgentOverrides } from "./config.js";

export interface AgentDef {
  name: string;
  model: string;
  workspaceDir: string; // where their SOUL.md/AGENTS.md live
}

function buildAgents(): Record<string, AgentDef> {
  const agentsDir = path.join(config.workspace, "agents");
  const overrides = getAgentOverrides();
  const agents: Record<string, AgentDef> = {};

  // Auto-register any subdirectory in agents/ that has a SOUL.md
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const agentDir = path.join(agentsDir, name);
      if (!existsSync(path.join(agentDir, "SOUL.md"))) continue;

      const override = overrides[name] ?? {};
      agents[name] = {
        name,
        model: override.model || config.claudeModel,
        workspaceDir: agentDir,
      };
    }
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
