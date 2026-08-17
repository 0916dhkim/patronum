export interface ToolCallEntry {
  name: string;
  input: Record<string, unknown>;
  timestamp: number;
  result: string;
}
