// Claude API types (subset we need)

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: CacheControl;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: ClaudeUsage;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<string>;
}
