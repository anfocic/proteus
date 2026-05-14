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

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

type ChatRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  reasoning_content?: string;
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
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export function openaiCompat(opts: {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
}): LLMProvider {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  // Note: `req.cacheSystemPrompt` and `tool.cacheBreakpoint` are deliberately
  // ignored here — they are Anthropic-only hints (ADR 0010). OpenAI-shape hosts
  // either don't expose explicit caching, or expose it via host-specific fields
  // that don't fit the normalized request. Silent ignore is intentional.
  return {
    async complete(req: CompletionRequest, completeOpts): Promise<CompletionResponse> {
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
        signal: completeOpts?.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw errorFromResponse("openai-compat", res, text, "request");
      }

      const data = (await res.json()) as ChatResponse;
      const choice = data.choices[0];
      const msg = choice.message;

      const content: ContentBlock[] = [];
      // Capture reasoning even if empty — some providers (Moonshot/Kimi) require
      // the field be present on echoes when thinking is enabled.
      if (typeof msg.reasoning_content === "string") {
        content.push({ type: "reasoning", text: msg.reasoning_content });
      }
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
        usage: openaiUsage(data.usage),
        raw: data,
      };
    },

    async *stream(req, streamOpts) {
      const signal = streamOpts?.signal;
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }

      const messages: ChatMessage[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      for (const m of req.messages) messages.push(...toOpenAIMessages(m));

      const body = {
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
        stream: true,
        stream_options: { include_usage: true },
      };

      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });

      let res: Response;
      try {
        res = await fetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(stripUndefined(body as unknown as Record<string, unknown>)),
          signal: ctrl.signal,
        });
      } catch (e) {
        signal?.removeEventListener("abort", onAbort);
        if (isAbortError(e)) throw e;
        throw new LLMTransportError({
          provider: "openai-compat",
          message: "OpenAI stream: transport failure during request",
          phase: "stream",
          cause: e,
        });
      }

      if (!res.ok) {
        const text = await res.text();
        signal?.removeEventListener("abort", onAbort);
        throw errorFromResponse("openai-compat", res, text, "stream");
      }
      if (!res.body) {
        signal?.removeEventListener("abort", onAbort);
        throw new LLMStreamError({
          provider: "openai-compat",
          message: "OpenAI stream: response has no body",
          phase: "stream",
        });
      }

      try {
        yield* streamFromOpenAISSE(parseSSE(res.body, ctrl.signal));
      } catch (e) {
        if (isAbortError(e)) throw e;
        if (e instanceof LLMTransportError || e instanceof LLMStreamError) throw e;
        throw new LLMTransportError({
          provider: "openai-compat",
          message: "OpenAI stream: transport failure mid-stream",
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

interface OpenAIStreamChoice {
  index?: number;
  finish_reason?: string | null;
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
}
interface OpenAIStreamChunk {
  id?: string;
  choices?: OpenAIStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface ToolAccum {
  index: number;          // normalized (our) index
  id?: string;
  name?: string;
  args: string;
  startEmitted: boolean;
  stopEmitted: boolean;
}

export async function* streamFromOpenAISSE(
  records: AsyncIterable<SSERecord>,
): AsyncGenerator<StreamEvent, void, void> {
  let messageIdSent = false;
  let textIndex: number | undefined;
  let reasoningIndex: number | undefined;
  let nextNormalIndex = 0;
  const tools = new Map<number, ToolAccum>();   // keyed by provider index
  const textChunks: string[] = [];
  const reasoningChunks: string[] = [];
  let stopReason: StopReason = "error";
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  for await (const rec of records) {
    if (rec.data === "[DONE]") break;

    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(rec.data);
    } catch {
      continue;
    }

    if (!messageIdSent) {
      messageIdSent = true;
      yield chunk.id ? { type: "message_start", id: chunk.id } : { type: "message_start" };
    }

    if (chunk.usage) {
      usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
      usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      if (cached !== undefined) usage.cacheReadInputTokens = cached;
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (delta) {
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        if (reasoningIndex === undefined) reasoningIndex = nextNormalIndex++;
        reasoningChunks.push(delta.reasoning_content);
        yield { type: "reasoning_delta", index: reasoningIndex, text: delta.reasoning_content };
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (textIndex === undefined) textIndex = nextNormalIndex++;
        textChunks.push(delta.content);
        yield { type: "text_delta", index: textIndex, text: delta.content };
      }

      if (delta.tool_calls) {
        for (let arrPos = 0; arrPos < delta.tool_calls.length; arrPos++) {
          const tc = delta.tool_calls[arrPos];
          // Provider index, with fallback to array position when omitted
          // (some compat hosts drop it on single-tool calls).
          const provIdx = tc.index ?? arrPos;
          let accum = tools.get(provIdx);
          if (!accum) {
            accum = {
              index: nextNormalIndex++,
              args: "",
              startEmitted: false,
              stopEmitted: false,
            };
            tools.set(provIdx, accum);
          }
          if (tc.id !== undefined) accum.id = tc.id;
          if (tc.function?.name !== undefined) accum.name = tc.function.name;
          if (tc.function?.arguments !== undefined) accum.args += tc.function.arguments;

          if (!accum.startEmitted && accum.id !== undefined && accum.name !== undefined) {
            accum.startEmitted = true;
            yield { type: "tool_use_start", index: accum.index, id: accum.id, name: accum.name };
          }
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason);

      // Close any open tool blocks with parsed input.
      for (const accum of tools.values()) {
        if (accum.stopEmitted) continue;
        if (!accum.startEmitted && accum.id !== undefined && accum.name !== undefined) {
          accum.startEmitted = true;
          yield { type: "tool_use_start", index: accum.index, id: accum.id, name: accum.name };
        }
        if (!accum.startEmitted) continue; // truly orphan (no id/name ever) — drop

        let input: unknown = {};
        if (accum.args) {
          try {
            input = JSON.parse(accum.args);
          } catch {
            input = { _raw: accum.args };
          }
        }
        accum.stopEmitted = true;
        yield { type: "tool_use_stop", index: accum.index, input };
      }

      // Assemble final content in normalized index order.
      const content: ContentBlock[] = [];
      type Entry = { idx: number; block: ContentBlock };
      const entries: Entry[] = [];
      if (reasoningIndex !== undefined) {
        entries.push({
          idx: reasoningIndex,
          block: { type: "reasoning", text: reasoningChunks.join("") },
        });
      }
      if (textIndex !== undefined) {
        entries.push({
          idx: textIndex,
          block: { type: "text", text: textChunks.join("") },
        });
      }
      for (const accum of tools.values()) {
        if (!accum.startEmitted || accum.id === undefined || accum.name === undefined) continue;
        let input: unknown = {};
        if (accum.args) {
          try {
            input = JSON.parse(accum.args);
          } catch {
            input = { _raw: accum.args };
          }
        }
        entries.push({
          idx: accum.index,
          block: { type: "tool_use", id: accum.id, name: accum.name, input },
        });
      }
      entries.sort((a, b) => a.idx - b.idx);
      for (const e of entries) content.push(e.block);

      yield { type: "message_stop", stopReason, usage, content };
      return;
    }
  }
}

function openaiUsage(u: OpenAIUsage | undefined): Usage {
  const out: Usage = {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
  };
  const cached = u?.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cacheReadInputTokens = cached;
  return out;
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
  const reasonings = blocks.filter((b) => b.type === "reasoning") as Array<{
    type: "reasoning";
    text: string;
  }>;
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
    // Moonshot/Kimi requires reasoning_content to be present on assistant
    // tool-call echoes when thinking is enabled. Default to empty string so
    // the field exists even when the provider returned no reasoning.
    out.reasoning_content = reasonings.map((r) => r.text).join("");
  } else if (reasonings.length > 0) {
    out.reasoning_content = reasonings.map((r) => r.text).join("");
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
