import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LLMAuthError,
  LLMBadRequestError,
  LLMRateLimitError,
  LLMServerError,
  LLMTransportError,
  withRetry,
} from "../src/index.ts";
import type { LLMProvider } from "../src/index.ts";
import type { CompletionRequest, CompletionResponse, StreamEvent } from "../src/llm/types.ts";

const baseReq: CompletionRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

const ok: CompletionResponse = {
  id: "r",
  content: [{ type: "text", text: "ok" }],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
};

function makeProvider(
  completeImpls: Array<() => Promise<CompletionResponse>>,
  streamImpls: Array<() => AsyncGenerator<StreamEvent, void, void>> = [],
): { llm: LLMProvider; calls: { complete: number; stream: number } } {
  const calls = { complete: 0, stream: 0 };
  const llm: LLMProvider = {
    async complete() {
      const i = calls.complete++;
      const fn = completeImpls[Math.min(i, completeImpls.length - 1)];
      return fn();
    },
    stream() {
      const i = calls.stream++;
      const fn = streamImpls[Math.min(i, streamImpls.length - 1)];
      return fn();
    },
  };
  return { llm, calls };
}

const noSleep = () => Promise.resolve();

test("complete: retries LLMServerError then succeeds", async () => {
  const { llm, calls } = makeProvider([
    async () => {
      throw new LLMServerError({
        provider: "anthropic",
        message: "boom",
        status: 503,
        phase: "request",
      });
    },
    async () => ok,
  ]);
  const wrapped = withRetry(llm, { sleep: noSleep, jitter: false });
  const res = await wrapped.complete(baseReq);
  assert.equal(res.id, "r");
  assert.equal(calls.complete, 2);
});

test("complete: retries LLMTransportError", async () => {
  const { llm, calls } = makeProvider([
    async () => {
      throw new LLMTransportError({
        provider: "openai-compat",
        message: "ECONNRESET",
        phase: "request",
        cause: new TypeError("fetch failed"),
      });
    },
    async () => ok,
  ]);
  const wrapped = withRetry(llm, { sleep: noSleep, jitter: false });
  await wrapped.complete(baseReq);
  assert.equal(calls.complete, 2);
});

test("complete: never retries LLMAuthError", async () => {
  const { llm, calls } = makeProvider([
    async () => {
      throw new LLMAuthError({
        provider: "anthropic",
        message: "bad key",
        status: 401,
        phase: "request",
      });
    },
    async () => ok,
  ]);
  const wrapped = withRetry(llm, { sleep: noSleep, jitter: false });
  await assert.rejects(() => wrapped.complete(baseReq), LLMAuthError);
  assert.equal(calls.complete, 1);
});

test("complete: never retries LLMBadRequestError", async () => {
  const { llm } = makeProvider([
    async () => {
      throw new LLMBadRequestError({
        provider: "anthropic",
        message: "bad body",
        status: 422,
        phase: "request",
      });
    },
  ]);
  const wrapped = withRetry(llm, { sleep: noSleep });
  await assert.rejects(() => wrapped.complete(baseReq), LLMBadRequestError);
});

test("complete: rate-limit honors retryAfter (seconds → ms)", async () => {
  const slept: number[] = [];
  const { llm } = makeProvider([
    async () => {
      throw new LLMRateLimitError({
        provider: "openai-compat",
        message: "slow down",
        status: 429,
        phase: "request",
        retryAfter: 7,
      });
    },
    async () => ok,
  ]);
  const wrapped = withRetry(llm, {
    sleep: async (ms) => {
      slept.push(ms);
    },
    jitter: false,
  });
  await wrapped.complete(baseReq);
  assert.deepEqual(slept, [7000]);
});

test("complete: rate-limit retryAfter capped at maxMs", async () => {
  const slept: number[] = [];
  const { llm } = makeProvider([
    async () => {
      throw new LLMRateLimitError({
        provider: "openai-compat",
        message: "slow",
        status: 429,
        phase: "request",
        retryAfter: 600,
      });
    },
    async () => ok,
  ]);
  const wrapped = withRetry(llm, {
    sleep: async (ms) => {
      slept.push(ms);
    },
    maxMs: 5_000,
    jitter: false,
  });
  await wrapped.complete(baseReq);
  assert.deepEqual(slept, [5_000]);
});

test("complete: gives up after maxAttempts and throws last error", async () => {
  const { llm, calls } = makeProvider([
    async () => {
      throw new LLMServerError({
        provider: "anthropic",
        message: "still down",
        status: 503,
        phase: "request",
      });
    },
  ]);
  const wrapped = withRetry(llm, { sleep: noSleep, jitter: false, maxAttempts: 3 });
  await assert.rejects(() => wrapped.complete(baseReq), LLMServerError);
  assert.equal(calls.complete, 3);
});

test("complete: exponential backoff (no jitter) doubles", async () => {
  const slept: number[] = [];
  const { llm } = makeProvider([
    async () => {
      throw new LLMServerError({
        provider: "anthropic",
        message: "x",
        status: 500,
        phase: "request",
      });
    },
    async () => {
      throw new LLMServerError({
        provider: "anthropic",
        message: "x",
        status: 500,
        phase: "request",
      });
    },
    async () => ok,
  ]);
  const wrapped = withRetry(llm, {
    sleep: async (ms) => {
      slept.push(ms);
    },
    baseMs: 100,
    jitter: false,
    maxAttempts: 3,
  });
  await wrapped.complete(baseReq);
  assert.deepEqual(slept, [100, 200]);
});

test("complete: onRetry fires per retry with attempt + delay", async () => {
  const events: Array<{ attempt: number; delayMs: number; code: string }> = [];
  const { llm } = makeProvider([
    async () => {
      throw new LLMServerError({
        provider: "anthropic",
        message: "x",
        status: 500,
        phase: "request",
      });
    },
    async () => ok,
  ]);
  const wrapped = withRetry(llm, {
    sleep: noSleep,
    jitter: false,
    baseMs: 50,
    onRetry: ({ error, attempt, delayMs }) => {
      events.push({ attempt, delayMs, code: error.code });
    },
  });
  await wrapped.complete(baseReq);
  assert.deepEqual(events, [{ attempt: 1, delayMs: 50, code: "server" }]);
});

async function* errStream(err: unknown): AsyncGenerator<StreamEvent, void, void> {
  throw err;
}

async function* okStream(): AsyncGenerator<StreamEvent, void, void> {
  yield { type: "message_start" };
  yield { type: "text_delta", index: 0, text: "hi" };
  yield {
    type: "message_stop",
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
    content: [{ type: "text", text: "hi" }],
  };
}

test("stream: retries when no events yielded yet", async () => {
  const { llm, calls } = makeProvider(
    [],
    [
      () =>
        errStream(
          new LLMServerError({
            provider: "anthropic",
            message: "x",
            status: 503,
            phase: "request",
          }),
        ),
      () => okStream(),
    ],
  );
  const wrapped = withRetry(llm, { sleep: noSleep, jitter: false });
  const out: StreamEvent[] = [];
  for await (const ev of wrapped.stream(baseReq)) out.push(ev);
  assert.equal(calls.stream, 2);
  assert.equal(out.length, 3);
});

test("stream: does NOT retry once events yielded", async () => {
  async function* partial(): AsyncGenerator<StreamEvent, void, void> {
    yield { type: "message_start" };
    throw new LLMTransportError({
      provider: "anthropic",
      message: "disconnect",
      phase: "stream",
    });
  }
  const { llm, calls } = makeProvider([], [() => partial(), () => okStream()]);
  const wrapped = withRetry(llm, { sleep: noSleep, jitter: false });
  await assert.rejects(async () => {
    for await (const _ of wrapped.stream(baseReq)) void _;
  }, LLMTransportError);
  assert.equal(calls.stream, 1);
});

test("stream: never retries auth errors even before any events", async () => {
  const { llm, calls } = makeProvider(
    [],
    [
      () =>
        errStream(
          new LLMAuthError({
            provider: "anthropic",
            message: "bad",
            status: 401,
            phase: "stream",
          }),
        ),
      () => okStream(),
    ],
  );
  const wrapped = withRetry(llm, { sleep: noSleep });
  await assert.rejects(async () => {
    for await (const _ of wrapped.stream(baseReq)) void _;
  }, LLMAuthError);
  assert.equal(calls.stream, 1);
});

test("stream: abort during retry sleep surfaces AbortError", async () => {
  const { llm } = makeProvider(
    [],
    [
      () =>
        errStream(
          new LLMServerError({
            provider: "anthropic",
            message: "x",
            status: 503,
            phase: "request",
          }),
        ),
      () => okStream(),
    ],
  );
  const ctrl = new AbortController();
  const wrapped = withRetry(llm, {
    jitter: false,
    sleep: (_ms, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(signal.reason ?? new DOMException("aborted", "AbortError")),
        );
        setImmediate(() => ctrl.abort());
      }),
  });
  await assert.rejects(
    async () => {
      for await (const _ of wrapped.stream(baseReq, { signal: ctrl.signal })) void _;
    },
    (err: unknown) => (err as Error).name === "AbortError",
  );
});
