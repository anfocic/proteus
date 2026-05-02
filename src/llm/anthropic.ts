import type { LLMProvider } from "./provider.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  StopReason,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[] | string;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicResponse {
  id: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export function anthropic(opts: {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
}): LLMProvider {
  const baseURL = opts.baseURL ?? DEFAULT_BASE_URL;

  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const body = {
        model: req.model || opts.defaultModel || "claude-sonnet-4-5",
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        tool_choice: req.toolChoice,
        temperature: req.temperature,
      };

      const res = await fetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(stripUndefined(body)),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic ${res.status}: ${text}`);
      }

      const data = (await res.json()) as AnthropicResponse;

      return {
        id: data.id,
        content: data.content.map(fromAnthropicBlock),
        stopReason: mapStopReason(data.stop_reason),
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
        raw: data,
      };
    },
  };
}

function toAnthropicMessage(msg: Message): AnthropicMessage {
  if (msg.role === "tool_result") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: msg.toolUseId,
          content: msg.content,
          is_error: msg.isError,
        },
      ],
    };
  }
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const b of msg.content) {
    if (b.type === "text") blocks.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") {
      blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
    // reasoning blocks are dropped on the way out — Anthropic uses a different
    // thinking-block shape that we don't support yet
  }
  return { role: msg.role, content: blocks };
}

function fromAnthropicBlock(
  block: { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown },
): ContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  return { type: "tool_use", id: block.id, name: block.name, input: block.input };
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "error";
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
