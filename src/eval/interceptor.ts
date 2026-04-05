import { ToolExecutor } from "../agent.js";

export interface ToolCallEntry {
  name: string;
  input: Record<string, unknown>;
  timestamp: number;
  result: string;
}

export interface Interceptor {
  executor: ToolExecutor;
  getLog: () => ToolCallEntry[];
}

export interface InterceptorOptions {
  /** If true, mock only dangerous tools. Everything else is real. (default: false) */
  subagentMode?: boolean;
}

/**
 * Create an intercepted tool executor for eval runs.
 * 
 * Lin mode (default): Logs every tool call. Real execution for read and memory_search.
 * Everything else returns a mock response.
 * 
 * Subagent mode: Logs every tool call. Real execution for most tools EXCEPT
 * dangerous/unsafe ones (self_restart, spawn_agent, memory_write, etc).
 */
export function createInterceptor(
  realExecutor: (name: string, input: Record<string, unknown>) => Promise<{ result: string; isError: boolean }>,
  options?: InterceptorOptions
): Interceptor {
  const log: ToolCallEntry[] = [];
  const subagentMode = options?.subagentMode ?? false;

  const executor: ToolExecutor = async (name: string, input: Record<string, unknown>) => {
    const timestamp = Date.now();

    // Tools to always mock in any mode (dangerous, global-state mutation, costly)
    const dangerousTools = new Set([
      "self_restart",
      "spawn_agent",
      "cancel_agent",
      "memory_write",
      "vaultwarden",
      "send_media",
      "list_tasks",
      "read_agent_thread",
      "list_agent_threads",
    ]);

    // In Lin mode: only real tools are read and memory_search
    const realToolsLinMode = new Set(["read", "memory_search"]);

    let shouldExecuteReally: boolean;
    if (subagentMode) {
      // Subagent mode: execute all EXCEPT dangerous tools
      shouldExecuteReally = !dangerousTools.has(name);
    } else {
      // Lin mode: execute only whitelisted tools
      shouldExecuteReally = realToolsLinMode.has(name);
    }

    if (shouldExecuteReally) {
      try {
        const { result, isError } = await realExecutor(name, input);
        log.push({ name, input, timestamp, result });
        return { result, isError };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.push({ name, input, timestamp, result: `(error: ${errorMsg})` });
        return { result: `(error: ${errorMsg})`, isError: true };
      }
    }

    // Mock response for disabled tools
    const mocks: Record<string, string> = {
      exec: "(eval: command not executed)",
      write: "(eval: file not written)",
      edit: "(eval: file not edited)",
      send_media: "(eval: media not sent)",
      spawn_agent: "(eval: agent not spawned)",
      cancel_agent: "(eval: no tasks to cancel)",
      list_tasks: "(eval: no active tasks)",
      memory_write: "(eval: memory not written)",
      self_restart: "(eval: restart not triggered)",
      search: "(eval: web search not executed)",
      vaultwarden: "(eval: vault not accessed)",
      read_agent_thread: "(eval: no thread context)",
      list_agent_threads: "(eval: no active threads)",
    };

    const result = mocks[name] || `(eval: ${name} not executed)`;
    log.push({ name, input, timestamp, result });
    return { result, isError: false };
  };

  return {
    executor,
    getLog: () => [...log],
  };
}
