import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LLMProvider,
  Message,
  StopReason,
} from "../src/index.ts";

export interface MockProvider extends LLMProvider {
  calls: CompletionRequest[];
}

export function mockProvider(turns: CompletionResponse[]): MockProvider {
  const calls: CompletionRequest[] = [];
  let i = 0;
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const res = turns[i] ?? turns[turns.length - 1];
      i++;
      return res;
    },
  };
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
