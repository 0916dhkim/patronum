import path from "node:path";
import { config } from "./config.js";

export interface AgentDef {
  name: string;
  model: string;
  workspaceDir: string; // where their SOUL.md/AGENTS.md live
}

function buildAgents(): Record<string, AgentDef> {
  const agentsDir = path.join(config.workspace, "agents");
  return {
    lin: {
      name: "lin",
      model: config.claudeModel,
      workspaceDir: path.join(agentsDir, "lin"),
    },
    alex: {
      name: "alex",
      model: "claude-opus-4-6",
      workspaceDir: path.join(agentsDir, "alex"),
    },
    iris: {
      name: "iris",
      model: config.claudeModel,
      workspaceDir: path.join(agentsDir, "iris"),
    },
    quill: {
      name: "quill",
      model: config.claudeModel,
      workspaceDir: path.join(agentsDir, "quill"),
    },
  };
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
