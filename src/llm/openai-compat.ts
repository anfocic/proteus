import type { LLMProvider } from "./provider.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  StopReason,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

type ChatRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }>;
  tool_choice?: "auto" | "required";
  max_tokens?: number;
  temperature?: number;
}

interface ChatResponse {
  id: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function openaiCompat(opts: {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
}): LLMProvider {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const messages: ChatMessage[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      for (const m of req.messages) messages.push(...toOpenAIMessages(m));

      const body: ChatRequest = {
        model: req.model || opts.defaultModel || "gpt-4o",
        messages,
        tools: req.tools?.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
        tool_choice: req.toolChoice
          ? req.toolChoice.type === "any" ? "required" : "auto"
          : undefined,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      };

      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(stripUndefined(body as unknown as Record<string, unknown>)),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI ${res.status}: ${text}`);
      }

      const data = (await res.json()) as ChatResponse;
      const choice = data.choices[0];
      const msg = choice.message;

      const content: ContentBlock[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const call of msg.tool_calls ?? []) {
        if (call.type !== "function") continue;
        let input: unknown = {};
        try {
          input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          input = { _raw: call.function.arguments };
        }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }

      return {
        id: data.id,
        content,
        stopReason: mapFinishReason(choice.finish_reason),
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
        raw: data,
      };
    },
  };
}

function toOpenAIMessages(msg: Message): ChatMessage[] {
  if (msg.role === "tool_result") {
    return [{ role: "tool", tool_call_id: msg.toolUseId, content: msg.content }];
  }

  if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text: string }).text)
            .join("");
    return [{ role: "user", content: text }];
  }

  // assistant
  const blocks = msg.content;
  const texts = blocks.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
  const toolUses = blocks.filter((b) => b.type === "tool_use") as Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
  }>;
  const out: ChatMessage = {
    role: "assistant",
    content: texts.map((t) => t.text).join("") || null,
  };
  if (toolUses.length > 0) {
    out.tool_calls = toolUses.map((t) => ({
      id: t.id,
      type: "function",
      function: { name: t.name, arguments: JSON.stringify(t.input) },
    }));
  }
  return [out];
}

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
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
