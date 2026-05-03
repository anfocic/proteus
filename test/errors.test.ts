import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  anthropic,
  LLMAuthError,
  LLMBadRequestError,
  LLMError,
  LLMRateLimitError,
  LLMServerError,
  LLMStreamError,
  LLMTransportError,
  openaiCompat,
} from "../src/index.ts";
import {
  errorFromResponse,
  isAbortError,
  parseErrorBody,
} from "../src/llm/errors.ts";

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const userMsg = { role: "user" as const, content: "hi" };

test("parseErrorBody Anthropic shape → type + message", () => {
  const out = parseErrorBody(
    "anthropic",
    JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
  );
  assert.deepEqual(out, { type: "authentication_error", message: "invalid x-api-key" });
});

test("parseErrorBody OpenAI shape → type + message + code", () => {
  const out = parseErrorBody(
    "openai-compat",
    JSON.stringify({ error: { message: "Invalid auth", type: "invalid_request_error", code: "invalid_api_key" } }),
  );
  assert.deepEqual(out, {
    type: "invalid_request_error",
    message: "Invalid auth",
    code: "invalid_api_key",
  });
});

test("parseErrorBody non-JSON returns undefined", () => {
  assert.equal(parseErrorBody("anthropic", "<html>oops</html>"), undefined);
});

test("errorFromResponse 401 → LLMAuthError", () => {
  const err = errorFromResponse(
    "anthropic",
    { status: 401, headers: new Headers() },
    JSON.stringify({ type: "error", error: { type: "authentication_error", message: "no key" } }),
    "request",
  );
  assert.ok(err instanceof LLMAuthError);
  assert.equal(err.code, "auth");
  assert.equal(err.provider, "anthropic");
  assert.equal(err.status, 401);
  assert.equal(err.phase, "request");
  assert.equal(err.parsed?.message, "no key");
});

test("errorFromResponse 429 with Retry-After → LLMRateLimitError, retryAfter parsed", () => {
  const err = errorFromResponse(
    "openai-compat",
    { status: 429, headers: new Headers({ "retry-after": "30" }) },
    JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }),
    "request",
  );
  assert.ok(err instanceof LLMRateLimitError);
  assert.equal(err.retryAfter, 30);
});

test("errorFromResponse 429 without Retry-After → retryAfter undefined", () => {
  const err = errorFromResponse(
    "openai-compat",
    { status: 429, headers: new Headers() },
    "rate limited",
    "request",
  );
  assert.ok(err instanceof LLMRateLimitError);
  assert.equal(err.retryAfter, undefined);
});

test("errorFromResponse 422 → LLMBadRequestError", () => {
  const err = errorFromResponse("anthropic", { status: 422, headers: new Headers() }, "bad", "request");
  assert.ok(err instanceof LLMBadRequestError);
});

test("errorFromResponse 503 → LLMServerError", () => {
  const err = errorFromResponse("anthropic", { status: 503, headers: new Headers() }, "down", "request");
  assert.ok(err instanceof LLMServerError);
});

test("errorFromResponse 418 → base LLMError code:unknown", () => {
  const err = errorFromResponse("anthropic", { status: 418, headers: new Headers() }, "teapot", "request");
  assert.equal(err.constructor.name, "LLMError");
  assert.equal(err.code, "unknown");
  assert.ok(!(err instanceof LLMAuthError));
  assert.ok(!(err instanceof LLMServerError));
});

test("isAbortError detects DOMException AbortError", () => {
  assert.equal(isAbortError(new DOMException("aborted", "AbortError")), true);
  const e = new Error("aborted");
  e.name = "AbortError";
  assert.equal(isAbortError(e), true);
  assert.equal(isAbortError(new Error("plain")), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError("aborted"), false);
});

test("Anthropic adapter complete 401 → LLMAuthError", async () => {
  const restore = stubFetch(async () =>
    new Response(
      JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid api key" } }),
      { status: 401 },
    ),
  );
  try {
    const llm = anthropic({ apiKey: "bad" });
    await assert.rejects(
      () => llm.complete({ model: "m", messages: [userMsg] }),
      (err: unknown) => {
        assert.ok(err instanceof LLMAuthError, `expected LLMAuthError, got ${(err as Error).constructor.name}`);
        const e = err as LLMAuthError;
        assert.equal(e.provider, "anthropic");
        assert.equal(e.status, 401);
        assert.equal(e.phase, "request");
        assert.equal(e.parsed?.message, "invalid api key");
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("Anthropic adapter stream 429 initial → LLMRateLimitError with retryAfter, phase=stream", async () => {
  const restore = stubFetch(async () =>
    new Response("{}", { status: 429, headers: { "retry-after": "5" } }),
  );
  try {
    const llm = anthropic({ apiKey: "x" });
    await assert.rejects(
      async () => {
        for await (const _ of llm.stream({ model: "m", messages: [userMsg] })) {
          void _;
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof LLMRateLimitError);
        const e = err as LLMRateLimitError;
        assert.equal(e.retryAfter, 5);
        assert.equal(e.phase, "stream");
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("OpenAI adapter complete 500 → LLMServerError", async () => {
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }),
  );
  try {
    const llm = openaiCompat({ apiKey: "x", baseURL: "https://example.test/v1" });
    await assert.rejects(
      () => llm.complete({ model: "m", messages: [userMsg] }),
      (err: unknown) => {
        assert.ok(err instanceof LLMServerError);
        const e = err as LLMServerError;
        assert.equal(e.provider, "openai-compat");
        assert.equal(e.status, 500);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("OpenAI adapter stream no body → LLMStreamError", async () => {
  // Build a 200 response with null body via Response sub-shape.
  const restore = stubFetch(async () => {
    // A new Response("") has a body; force null by overriding the descriptor.
    const res = new Response("");
    Object.defineProperty(res, "body", { get: () => null });
    return res;
  });
  try {
    const llm = openaiCompat({ apiKey: "x", baseURL: "https://example.test/v1" });
    await assert.rejects(
      async () => {
        for await (const _ of llm.stream({ model: "m", messages: [userMsg] })) {
          void _;
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof LLMStreamError);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("Abort during stream is NOT wrapped as LLMError", async () => {
  // Stream starts, then signal aborts mid-stream → should surface as DOMException, not LLMError.
  const restore = stubFetch(async (_url, init) => {
    const sig = init?.signal as AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        sig?.addEventListener("abort", () => {
          controller.error(sig.reason ?? new DOMException("aborted", "AbortError"));
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  try {
    const llm = anthropic({ apiKey: "x" });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    await assert.rejects(
      async () => {
        for await (const _ of llm.stream({ model: "m", messages: [userMsg] }, { signal: ctrl.signal })) {
          void _;
        }
      },
      (err: unknown) => {
        assert.ok(!(err instanceof LLMError), "abort must not become LLMError");
        assert.ok(isAbortError(err), `expected AbortError, got ${(err as Error)?.name}`);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("Mid-stream transport failure IS wrapped as LLMTransportError", async () => {
  const restore = stubFetch(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        // Simulate disconnect mid-stream after a microtask.
        queueMicrotask(() => controller.error(new TypeError("network reset")));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  try {
    const llm = openaiCompat({ apiKey: "x", baseURL: "https://example.test/v1" });
    await assert.rejects(
      async () => {
        for await (const _ of llm.stream({ model: "m", messages: [userMsg] })) {
          void _;
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof LLMTransportError, `expected LLMTransportError, got ${(err as Error).constructor.name}`);
        const e = err as LLMTransportError;
        assert.equal(e.phase, "stream");
        assert.ok(e.cause instanceof TypeError);
        return true;
      },
    );
  } finally {
    restore();
  }
});
