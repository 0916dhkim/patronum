export interface AgentDef {
  name: string;
  model: string;
  workspaceDir: string; // where their SOUL.md/AGENTS.md live
}

export const AGENTS: Record<string, AgentDef> = {
  lin: {
    name: "lin",
    model: "claude-sonnet-4-6",
    workspaceDir: "/home/danny/patronum-workspace/agents/lin",
  },
  alex: {
    name: "alex",
    model: "claude-opus-4-6",
    workspaceDir: "/home/danny/patronum-workspace/agents/alex",
  },
  iris: {
    name: "iris",
    model: "claude-sonnet-4-6",
    workspaceDir: "/home/danny/patronum-workspace/agents/iris",
  },
  quill: {
    name: "quill",
    model: "claude-sonnet-4-6",
    workspaceDir: "/home/danny/patronum-workspace/agents/quill",
  },
};
