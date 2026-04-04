import type {
  ClaudeUsage,
  ContentBlock,
  Message,
  TextBlock,
} from "./types.js";

interface PreparedMessage {
  role: Message["role"];
  content: ContentBlock[];
}

function cloneBlock(block: ContentBlock): ContentBlock {
  if (block.type === "text") return { ...block };
  if (block.type === "tool_use") return { ...block, input: { ...block.input } };
  return { ...block };
}

function ensureBlockContent(message: Message): ContentBlock[] {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }

  return message.content.map(cloneBlock);
}

function setBreakpointOnMessage(message: PreparedMessage): PreparedMessage {
  const content = message.content.map(cloneBlock);

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "text") {
      content[i] = {
        ...block,
        cache_control: { type: "ephemeral" },
      };
      return { role: message.role, content };
    }
  }

  // Don't create empty text blocks with cache_control — Claude API rejects them
  // If there are no text blocks, just return the message as-is
  return { role: message.role, content };
}

function hasToolResults(message: Message): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result");
}

export interface PrepareMessagesOptions {
  completedPrefixLength?: number;
  cacheInitialUserMessage?: boolean;
  cacheToolResults?: boolean;
}

export function prepareMessagesForClaude(
  messages: Message[],
  options: PrepareMessagesOptions = {}
): Message[] {
  const prepared: PreparedMessage[] = messages.map((message) => ({
    role: message.role,
    content: ensureBlockContent(message),
  }));

  const breakpointIndexes = new Set<number>();
  const completedPrefixLength = options.completedPrefixLength ?? 0;

  if (completedPrefixLength > 0 && completedPrefixLength <= prepared.length) {
    breakpointIndexes.add(completedPrefixLength - 1);
  }

  if (options.cacheInitialUserMessage && prepared[0]?.role === "user") {
    breakpointIndexes.add(0);
  }

  if (options.cacheToolResults !== false) {
    for (let i = prepared.length - 1; i >= 0; i--) {
      if (hasToolResults(prepared[i])) {
        breakpointIndexes.add(i);
        break;
      }
    }
  }

  for (const index of breakpointIndexes) {
    prepared[index] = setBreakpointOnMessage(prepared[index]);
  }

  return prepared.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function prepareSystemPromptForClaude(system: TextBlock[]): TextBlock[] {
  if (system.length === 0) return system;

  const prepared = system.map((block) => ({ ...block }));
  const lastIndex = prepared.length - 1;
  prepared[lastIndex] = {
    ...prepared[lastIndex],
    cache_control: { type: "ephemeral" },
  };
  return prepared;
}

export function getTotalInputTokens(usage?: ClaudeUsage): number {
  if (!usage) return 0;
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export function logUsage(scope: string, usage?: ClaudeUsage): void {
  if (!usage) return;

  const totalInputTokens = getTotalInputTokens(usage);
  const parts = [
    `input=${usage.input_tokens}`,
    `cache_write=${usage.cache_creation_input_tokens ?? 0}`,
    `cache_read=${usage.cache_read_input_tokens ?? 0}`,
    `total_input=${totalInputTokens}`,
    `output=${usage.output_tokens}`,
  ];

  console.log(`[usage:${scope}] ${parts.join(" ")}`);
}
