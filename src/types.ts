// Claude API types (subset we need)

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
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
  content: string | ContentBlock[];
  is_error?: boolean;
  cache_control?: CacheControl;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock;

export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  /**
   * OpenRouter-specific reasoning details (e.g. Gemini's reasoning.encrypted blocks).
   * Must be passed back to the API on subsequent turns for models that produce them,
   * otherwise the model loses its reasoning context and may return empty responses.
   */
  reasoning_details?: unknown[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

export interface ClaudeResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: ClaudeUsage;
  /**
   * OpenRouter-specific reasoning details (e.g. Gemini's reasoning.encrypted blocks).
   * Must be passed back to the API on subsequent turns for models that produce them,
   * otherwise the model loses its reasoning context and may return empty responses.
   */
  reasoning_details?: unknown[];
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
  /** If true, executing this tool should terminate the agent loop immediately */
  terminatesLoop?: boolean;
}

// --- Claude Streaming SSE Event Types ---

export interface StreamMessageStart {
  type: "message_start";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: [];
    model: string;
    stop_reason: null;
    usage: ClaudeUsage;
  };
}

export interface StreamContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, never> }
    | { type: "thinking"; thinking: string }
    | { type: "redacted_thinking"; data: string };
}

export interface StreamContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
    | { type: "redacted_thinking"; data: string };
}

export interface StreamContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface StreamMessageDelta {
  type: "message_delta";
  delta: { stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" };
  usage: { output_tokens: number };
  /**
   * OpenRouter-specific reasoning details accumulated during streaming.
   * Present when the model (e.g. Gemini) emits reasoning_details that must be
   * passed back on subsequent turns.
   */
  reasoning_details?: unknown[];
}

export interface StreamMessageStop {
  type: "message_stop";
}

export interface StreamPing {
  type: "ping";
}

export type StreamEvent =
  | StreamMessageStart
  | StreamContentBlockStart
  | StreamContentBlockDelta
  | StreamContentBlockStop
  | StreamMessageDelta
  | StreamMessageStop
  | StreamPing;
