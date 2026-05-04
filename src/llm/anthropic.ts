import type { LLMProvider } from "./provider.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  Usage,
} from "./types.ts";
import { parseSSE, type SSERecord } from "./sse.ts";
import {
  errorFromResponse,
  isAbortError,
  LLMStreamError,
  LLMTransportError,
} from "./errors.ts";

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
  usage: AnthropicUsage;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
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
        system: encodeSystem(req.system, req.cacheSystemPrompt),
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools?.map(encodeTool),
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
        throw errorFromResponse("anthropic", res, text, "request");
      }

      const data = (await res.json()) as AnthropicResponse;

      return {
        id: data.id,
        content: data.content.map(fromAnthropicBlock),
        stopReason: mapStopReason(data.stop_reason),
        usage: anthropicUsage(data.usage),
        raw: data,
      };
    },

    async *stream(req, streamOpts) {
      const signal = streamOpts?.signal;
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }

      const body = {
        model: req.model || opts.defaultModel || "claude-sonnet-4-5",
        max_tokens: req.maxTokens ?? 1024,
        system: encodeSystem(req.system, req.cacheSystemPrompt),
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools?.map(encodeTool),
        tool_choice: req.toolChoice,
        temperature: req.temperature,
        stream: true,
      };

      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });

      let res: Response;
      try {
        res = await fetch(`${baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(stripUndefined(body)),
          signal: ctrl.signal,
        });
      } catch (e) {
        signal?.removeEventListener("abort", onAbort);
        if (isAbortError(e)) throw e;
        throw new LLMTransportError({
          provider: "anthropic",
          message: "Anthropic stream: transport failure during request",
          phase: "stream",
          cause: e,
        });
      }

      if (!res.ok) {
        const text = await res.text();
        signal?.removeEventListener("abort", onAbort);
        throw errorFromResponse("anthropic", res, text, "stream");
      }
      if (!res.body) {
        signal?.removeEventListener("abort", onAbort);
        throw new LLMStreamError({
          provider: "anthropic",
          message: "Anthropic stream: response has no body",
          phase: "stream",
        });
      }

      try {
        yield* streamFromAnthropicSSE(parseSSE(res.body, ctrl.signal));
      } catch (e) {
        if (isAbortError(e)) throw e;
        if (e instanceof LLMTransportError || e instanceof LLMStreamError) throw e;
        throw new LLMTransportError({
          provider: "anthropic",
          message: "Anthropic stream: transport failure mid-stream",
          phase: "stream",
          cause: e,
        });
      } finally {
        ctrl.abort();
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

interface AnthropicMessageStart {
  type: "message_start";
  message: {
    id: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}
interface AnthropicContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string };
}
interface AnthropicContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: string };
}
interface AnthropicContentBlockStop {
  type: "content_block_stop";
  index: number;
}
interface AnthropicMessageDelta {
  type: "message_delta";
  delta: { stop_reason?: string | null };
  usage?: { output_tokens?: number };
}
interface AnthropicMessageStop {
  type: "message_stop";
}
type AnthropicStreamPayload =
  | AnthropicMessageStart
  | AnthropicContentBlockStart
  | AnthropicContentBlockDelta
  | AnthropicContentBlockStop
  | AnthropicMessageDelta
  | AnthropicMessageStop
  | { type: string };

export async function* streamFromAnthropicSSE(
  records: AsyncIterable<SSERecord>,
): AsyncGenerator<StreamEvent, void, void> {
  const blocks = new Map<number, ContentBlock>();
  const partialJson = new Map<number, string>();
  let stopReason: StopReason = "error";
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  for await (const rec of records) {
    let payload: AnthropicStreamPayload;
    try {
      payload = JSON.parse(rec.data);
    } catch {
      continue;
    }

    switch (payload.type) {
      case "message_start": {
        const p = payload as AnthropicMessageStart;
        usage.inputTokens = p.message.usage?.input_tokens ?? 0;
        usage.outputTokens = p.message.usage?.output_tokens ?? 0;
        if (p.message.usage?.cache_creation_input_tokens !== undefined) {
          usage.cacheCreationInputTokens = p.message.usage.cache_creation_input_tokens;
        }
        if (p.message.usage?.cache_read_input_tokens !== undefined) {
          usage.cacheReadInputTokens = p.message.usage.cache_read_input_tokens;
        }
        yield { type: "message_start", id: p.message.id };
        break;
      }
      case "content_block_start": {
        const p = payload as AnthropicContentBlockStart;
        if (p.content_block.type === "text") {
          blocks.set(p.index, { type: "text", text: "" });
        } else if (p.content_block.type === "tool_use") {
          const cb = p.content_block as { type: "tool_use"; id: string; name: string };
          blocks.set(p.index, { type: "tool_use", id: cb.id, name: cb.name, input: {} });
          partialJson.set(p.index, "");
          yield { type: "tool_use_start", index: p.index, id: cb.id, name: cb.name };
        }
        // ignore thinking and other unknown block types
        break;
      }
      case "content_block_delta": {
        const p = payload as AnthropicContentBlockDelta;
        if (p.delta.type === "text_delta") {
          const d = p.delta as { type: "text_delta"; text: string };
          const block = blocks.get(p.index);
          if (block && block.type === "text") block.text += d.text;
          yield { type: "text_delta", index: p.index, text: d.text };
        } else if (p.delta.type === "input_json_delta") {
          const d = p.delta as { type: "input_json_delta"; partial_json: string };
          partialJson.set(p.index, (partialJson.get(p.index) ?? "") + d.partial_json);
        }
        break;
      }
      case "content_block_stop": {
        const p = payload as AnthropicContentBlockStop;
        const block = blocks.get(p.index);
        if (block && block.type === "tool_use") {
          const accum = partialJson.get(p.index) ?? "";
          let input: unknown = {};
          if (accum) {
            try {
              input = JSON.parse(accum);
            } catch {
              input = { _raw: accum };
            }
          }
          block.input = input;
          yield { type: "tool_use_stop", index: p.index, input };
        }
        break;
      }
      case "message_delta": {
        const p = payload as AnthropicMessageDelta;
        if (p.delta.stop_reason !== undefined) {
          stopReason = mapStopReason(p.delta.stop_reason);
        }
        if (p.usage?.output_tokens !== undefined) {
          usage.outputTokens = p.usage.output_tokens;
        }
        break;
      }
      case "message_stop": {
        const ordered: ContentBlock[] = [];
        const indices = [...blocks.keys()].sort((a, b) => a - b);
        for (const i of indices) {
          const b = blocks.get(i);
          if (b) ordered.push(b);
        }
        yield { type: "message_stop", stopReason, usage, content: ordered };
        return;
      }
      // ping, error, and unknown event types are ignored
    }
  }
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

function anthropicUsage(u: AnthropicUsage): Usage {
  const out: Usage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
  };
  if (u.cache_creation_input_tokens !== undefined) {
    out.cacheCreationInputTokens = u.cache_creation_input_tokens;
  }
  if (u.cache_read_input_tokens !== undefined) {
    out.cacheReadInputTokens = u.cache_read_input_tokens;
  }
  return out;
}

function encodeSystem(
  system: string | undefined,
  cache: boolean | undefined,
): string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined {
  if (system === undefined) return undefined;
  if (!cache) return system;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

function encodeTool(t: { name: string; description: string; inputSchema: unknown; cacheBreakpoint?: boolean }) {
  const out: Record<string, unknown> = {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  };
  if (t.cacheBreakpoint) out.cache_control = { type: "ephemeral" };
  return out;
}
