export interface CompletionRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSchema[];
  toolChoice?: { type: "auto" } | { type: "any" };
  maxTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, unknown>;
  /**
   * When true, the Anthropic adapter emits the system prompt in structured
   * form with `cache_control: { type: "ephemeral" }`. Ignored by the
   * OpenAI-compat adapter (Anthropic-only feature). ADR 0010.
   */
  cacheSystemPrompt?: boolean;
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
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "reasoning"; text: string };

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: unknown;
  /**
   * When true, the Anthropic adapter emits this tool with
   * `cache_control: { type: "ephemeral" }`. Ignored by the OpenAI-compat
   * adapter. ADR 0010.
   */
  cacheBreakpoint?: boolean;
}

export type StreamEvent =
  | { type: "message_start"; id?: string }
  | { type: "message_stop"; stopReason: StopReason; usage: Usage; content: ContentBlock[] }
  | { type: "text_delta"; index: number; text: string }
  | { type: "reasoning_delta"; index: number; text: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_stop"; index: number; input: unknown };
