export interface CompletionRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSchema[];
  toolChoice?: { type: "auto" } | { type: "any" };
  maxTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, unknown>;
}

export interface CompletionResponse {
  id?: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  raw?: unknown;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type Message =
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: ContentBlock[] }
  | { role: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: unknown;
}
