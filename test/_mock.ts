import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  Usage,
} from "../src/llm/types.ts";
import type { LLMProvider } from "../src/llm/provider.ts";

export interface MockProvider extends LLMProvider {
  calls: CompletionRequest[];
}

export function mockProvider(turns: CompletionResponse[]): MockProvider {
  const calls: CompletionRequest[] = [];
  let i = 0;
  return {
    calls,
    async complete(req, opts) {
      calls.push(req);
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
      }
      const res = turns[i] ?? turns[turns.length - 1];
      i++;
      return res;
    },
    async *stream(req, opts) {
      calls.push(req);
      const res = turns[i] ?? turns[turns.length - 1];
      i++;
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
      }
      yield* completionToEvents(res);
    },
  };
}

export interface StreamMockProvider extends LLMProvider {
  calls: CompletionRequest[];
}

export function mockStreamProvider(turns: StreamEvent[][]): StreamMockProvider {
  const calls: CompletionRequest[] = [];
  let i = 0;
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const events = turns[i] ?? turns[turns.length - 1];
      i++;
      return assembleFromEvents(events);
    },
    async *stream(req, opts) {
      calls.push(req);
      const events = turns[i] ?? turns[turns.length - 1];
      i++;
      for (const ev of events) {
        if (opts?.signal?.aborted) {
          throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
        }
        yield ev;
      }
    },
  };
}

export function* completionToEvents(res: CompletionResponse): Generator<StreamEvent> {
  yield res.id ? { type: "message_start", id: res.id } : { type: "message_start" };
  let idx = 0;
  for (const block of res.content) {
    if (block.type === "text") {
      yield { type: "text_delta", index: idx, text: block.text };
    } else if (block.type === "reasoning") {
      yield { type: "reasoning_delta", index: idx, text: block.text };
    } else if (block.type === "tool_use") {
      yield { type: "tool_use_start", index: idx, id: block.id, name: block.name };
      yield { type: "tool_use_stop", index: idx, input: block.input };
    }
    idx++;
  }
  yield {
    type: "message_stop",
    stopReason: res.stopReason,
    usage: res.usage,
    content: res.content,
  };
}

function assembleFromEvents(events: StreamEvent[]): CompletionResponse {
  let id: string | undefined;
  let stopReason: StopReason = "error";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let content: ContentBlock[] = [];
  for (const e of events) {
    if (e.type === "message_start") id = e.id;
    else if (e.type === "message_stop") {
      stopReason = e.stopReason;
      usage = e.usage;
      content = e.content;
    }
  }
  const out: CompletionResponse = { content, stopReason, usage };
  if (id !== undefined) out.id = id;
  return out;
}

export function streamText(text: string, index = 0): StreamEvent[] {
  return [{ type: "text_delta", index, text }];
}

export function streamToolUse(id: string, name: string, input: unknown, index = 0): StreamEvent[] {
  return [
    { type: "tool_use_start", index, id, name },
    { type: "tool_use_stop", index, input },
  ];
}

export function streamTurn(
  blocks: StreamEvent[][],
  stopReason: StopReason,
  usage: Usage = { inputTokens: 0, outputTokens: 0 },
  content?: ContentBlock[],
): StreamEvent[] {
  const flat = blocks.flat();
  const assembledContent: ContentBlock[] = content ?? blocksFromEvents(flat);
  return [
    { type: "message_start" },
    ...flat,
    { type: "message_stop", stopReason, usage, content: assembledContent },
  ];
}

function blocksFromEvents(events: StreamEvent[]): ContentBlock[] {
  const byIndex = new Map<number, ContentBlock>();
  for (const e of events) {
    if (e.type === "text_delta") {
      const cur = byIndex.get(e.index);
      if (cur && cur.type === "text") cur.text += e.text;
      else byIndex.set(e.index, { type: "text", text: e.text });
    } else if (e.type === "reasoning_delta") {
      const cur = byIndex.get(e.index);
      if (cur && cur.type === "reasoning") cur.text += e.text;
      else byIndex.set(e.index, { type: "reasoning", text: e.text });
    } else if (e.type === "tool_use_start") {
      byIndex.set(e.index, { type: "tool_use", id: e.id, name: e.name, input: {} });
    } else if (e.type === "tool_use_stop") {
      const cur = byIndex.get(e.index);
      if (cur && cur.type === "tool_use") cur.input = e.input;
    }
  }
  return [...byIndex.keys()].sort((a, b) => a - b).map((k) => byIndex.get(k) as ContentBlock);
}

export function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

export function toolUse(id: string, name: string, input: unknown): ContentBlock {
  return { type: "tool_use", id, name, input };
}

export function response(content: ContentBlock[], stopReason: StopReason): CompletionResponse {
  return {
    content,
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

export function userMsg(t: string): Message {
  return { role: "user", content: t };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
