# 0006 — Typed error hierarchy from adapters

- **Status**: Accepted
- **Date**: 2026-05-03

## Context

Both LLM adapters previously threw raw `Error("Anthropic 429: <body>")` for any non-2xx response, and let mid-stream transport failures surface as bare `TypeError` from the underlying `ReadableStream`. Consumers couldn't distinguish auth from rate-limit from transient transport failure, couldn't read parsed error fields, and couldn't make retry decisions. As proteus starts being consumed by long-running channel adapters (Telegram, HTTP), differentiating "user cancelled the request" from "the provider is down" from "you got rate-limited and should back off N seconds" is table-stakes signal.

Two shapes were on the table:

1. **Tagged-union object** — one error class with a `kind: "auth" | "rate_limit" | ...` field.
2. **Class hierarchy** — `LLMAuthError extends LLMError`, etc., plus a `code` discriminator field for `switch`-style consumers.

## Decision

Ship a class hierarchy in `src/llm/errors.ts`:

```
LLMError (base, code: "unknown")
├── LLMAuthError       (401, 403)
├── LLMRateLimitError  (429, with retryAfter?: number)
├── LLMBadRequestError (400, 422)
├── LLMServerError     (5xx)
├── LLMTransportError  (fetch rejection, mid-stream disconnect)
└── LLMStreamError     (200 OK but missing body / unrecoverable SSE shape)
```

Every instance carries `provider`, `status?`, `body?`, `parsed?`, `phase: "request" | "stream"`, plus a `code` discriminator. Extra-specialised classes (`LLMRateLimitError`) attach extra fields. The base class also accepts a `cause` for chaining (used for transport errors wrapping a `TypeError` from the underlying stream reader).

Both adapters:

- Replace every `throw new Error(...)` for HTTP responses with `errorFromResponse(provider, res, body, phase)`.
- Wrap their `yield* streamFromXSSE(...)` site in a try/catch that re-throws `AbortError`/`LLMError` unchanged and tags everything else as `LLMTransportError({ cause: e })`.

`src/llm/sse.ts` stays provider-agnostic and is **not** modified — provider tagging happens in the adapter, not in the shared SSE parser. `Retry-After` parsing is numeric-seconds only for v1; HTTP-date form is deferred until something actually needs it.

`AbortError` is **never** wrapped. Cancellation and failure are different signals, and conflating them prevents callers from distinguishing "user clicked cancel" from "provider went down". The `isAbortError(err)` helper centralises the check (`err.name === "AbortError"`) so every adapter agrees.

## Consequences

**Buys us:**
- Consumers can `instanceof LLMRateLimitError` and read `retryAfter` to decide retry timing.
- A future retry/backoff layer can be built without touching adapters again.
- `parsed.message` / `parsed.code` from provider error bodies surface without the consumer needing to re-parse.
- Integration tests can pin the exact mapping (16 cases) and any future adapter regression breaks one of them.

**Costs:**
- `src/llm/errors.ts` is +~140 lines of taxonomy, all of it adapter-internal until consumers opt in.
- Every adapter throw site is now an indirection through `errorFromResponse`, slightly worse for grep.

**Locks out:**
- Auto-retry inside the adapter — explicitly out of scope. Adapters stay thin; retry is a layer above. (Same rule as caching: doesn't belong in the provider.)
- An `error` event in `AgentEvent` / `StreamEvent`. Errors throw out of the generator today; if structured in-band errors become useful, that's a separate decision.
- Wrapping tool-handler exceptions — those are already captured by `runHandler` in `src/agent/run.ts` and surface as `tool_result.isError`, which is the right shape for the model to see.
