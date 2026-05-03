# 0007 — Retry wrapper above the provider, not inside adapters

- **Status**: Accepted
- **Date**: 2026-05-03

## Context

ADR 0006 landed a typed error hierarchy precisely so that retry decisions could live somewhere. Nothing in proteus consumed those types yet. Real consumers (intrebit, any long-running channel) hit transient 5xx and 429 from both providers immediately — without retries, every transient blip becomes a user-visible failure.

Two shapes were on the table:

1. **Bake retry into each adapter.** Every `complete()` and `stream()` knows how to back off internally.
2. **Compose a wrapper over `LLMProvider`.** A `withRetry(llm, opts)` function returns a new provider that delegates to the inner one and retries on the right error subclasses.

Option 1 keeps usage trivial but conflates two concerns the abstraction was built to separate: the adapter's job is "translate request, fetch, translate response, throw on non-2xx" (CLAUDE.md). Retries are policy, not protocol. It also makes adapters harder to unit-test (every test now has to opt out of retry) and bakes a single retry policy into the framework.

## Decision

Ship `withRetry(llm: LLMProvider, opts?: RetryOpts): LLMProvider` in `src/llm/retry.ts`. It returns a provider with the same `LLMProvider` shape, transparently composable with anything that takes a provider (`runAgent`, `runSpecialist`, `orchestrate`, channel handlers).

Retry policy:

- **Retryable**: `LLMRateLimitError`, `LLMServerError`, `LLMTransportError`.
- **Never retried**: `LLMAuthError`, `LLMBadRequestError`, `LLMStreamError`, base `LLMError` (`code: "unknown"`), and anything `isAbortError()` returns true for.
- **Rate-limit delay**: if `LLMRateLimitError.retryAfter` is set, sleep `retryAfter * 1000` ms (capped at `maxMs`). Otherwise fall through to exponential backoff.
- **Exponential backoff**: `baseMs * 2^(attempt-1)`, capped at `maxMs`, with optional full-jitter (`Math.random() * capped`). Jitter on by default — uncoordinated clients all retrying at the same backoff curve is the textbook stampede.
- **Defaults**: `maxAttempts: 3`, `baseMs: 500`, `maxMs: 30_000`, `jitter: true`. Conservative — consumers needing aggressive retry override.
- **Observability hook**: `onRetry({ error, attempt, delayMs })` fires before each sleep. The hook is intentionally narrow; full lifecycle hooks belong in a separate observability layer (Tier 3).
- **Injectable sleep**: `sleep?(ms, signal?)` lets tests run in zero real time and lets advanced consumers swap timers (e.g. virtual time).

### Streaming policy

Streaming retry is bounded to the *pre-yield* window. Once the wrapped generator has yielded any `StreamEvent` to the consumer, a mid-stream failure surfaces unchanged — a partial assistant message has already been observed downstream and silently re-issuing the request would produce a duplicate. Failures *before* the first event (the request leg, or an SSE handshake that 429s before any data) follow the same retry rules as `complete()`.

This matches what consumers actually want: transparent recovery from "the provider hiccupped before we saw anything" and a hard fail on "the stream broke mid-token."

The retry sleep accepts the caller's `AbortSignal`. Aborting a retry sleep surfaces the abort, never an `LLMError`.

## Consequences

- Adapters stay unchanged — the abstraction line drawn in ADR 0006 holds.
- Consumers opt in: `const llm = withRetry(anthropic({ apiKey }), { maxAttempts: 5 })`. Nothing breaks for anyone who doesn't.
- The wrapper is composable with everything: `runAgent`, `streamAgent`, `runSpecialist`, `orchestrate`, channel handlers — none know it exists.
- A future user wanting a different policy (per-error-code attempt counts, circuit breakers, queueing) writes their own wrapper. The interface surface is small enough that this is genuinely tractable.
- We do **not** ship a circuit breaker, request queue, deduplication, or per-error-code policy table. Those are real concerns at scale, but each is its own design problem and none have a current consumer.
