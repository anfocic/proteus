# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Proteus — a provider-agnostic LLM agent framework, OSS portfolio piece. Currently at proof-of-concept stage. Single npm package, zero runtime dependencies (both adapters use `fetch` directly).

## Commands

```sh
npm install                      # tsx + typescript dev tooling only
npm run typecheck                # tsc --noEmit
PROVIDER=compat    npm run demo  # OpenAI-compatible host (set LLM_BASE_URL etc.)
PROVIDER=anthropic npm run demo  # Anthropic API
```

There are no tests yet. The smoke test *is* the demo — it must succeed against both providers for the abstraction to hold.

## Architecture

The repo is built around one load-bearing abstraction: `LLMProvider` in `src/llm/provider.ts`. Single method, `complete(req)`. Everything else hangs off it.

The wire format is defined in `src/llm/types.ts` and is a normalized superset of the two real-world LLM API shapes:

- **Anthropic shape**: content blocks (`text`, `tool_use`), `tool_result` as a block inside a `user` message.
- **OpenAI-compat shape**: flat string content, `tool_calls` array on assistant messages, `role: "tool"` messages for results.

Proteus's normalized message model uses **`tool_result` as a top-level message role**, not as a block. Each adapter folds it back into its native shape on the way out. This is the only non-trivial translation in either adapter — read it before changing anything in `anthropic.ts` or `openai-compat.ts`.

### Hard architectural invariant

`src/agent/run.ts` and any future framework code may import only from `src/llm/types.ts` and `src/llm/provider.ts`. It must **never** import an adapter file directly. Provider construction happens in user code (or the demo). Breaking this invariant defeats the abstraction — if you find yourself wanting to import `anthropic.ts` from `run.ts`, you've taken a wrong turn.

### The two adapters

Both live in `src/llm/`. Both are thin (~80–130 lines): translate request, `fetch`, translate response, throw on non-2xx. No retry, no timeout, no streaming, no caching. Those concerns live above the provider, not inside it.

`anthropic.ts` and `openai-compat.ts` exist together specifically because they cover the two structurally different LLM API shapes in the ecosystem. Every other major provider (Gemini, Mistral, Cohere, every OSS-model host) is a variant of one of these two. **If you add a third adapter, it should be because it's a third structurally distinct shape** — not just because you want a different vendor.

**Errors.** Both adapters throw typed errors from `src/llm/errors.ts`: `LLMAuthError` (401/403), `LLMRateLimitError` (429, with `retryAfter` when the response has a numeric `Retry-After` header), `LLMBadRequestError` (400/422), `LLMServerError` (5xx), `LLMTransportError` (fetch rejection / mid-stream disconnect — `cause` chained to the underlying error), `LLMStreamError` (200 OK but missing body or unrecoverable SSE shape). All extend `LLMError` and carry `provider`, `status?`, `body?`, `parsed?`, `phase: "request" | "stream"`, plus a `code` discriminator for switch-style consumers. **`AbortError` is never wrapped** — it surfaces as a `DOMException` so callers can distinguish cancellation from failure (`isAbortError(err)` is the helper). Auto-retry is out of scope inside adapters; layer it above. ADR 0006.

**Retry.** `withRetry(llm, opts)` in `src/llm/retry.ts` returns a wrapped `LLMProvider` that retries `LLMRateLimitError` (honouring `retryAfter`), `LLMServerError`, and `LLMTransportError` with full-jitter exponential backoff. Auth, bad-request, stream-shape, and abort errors never retry. Streaming retry is bounded to the *pre-yield* window — once any `StreamEvent` has reached the consumer, mid-stream failures surface unchanged to avoid duplicate output. Defaults: `maxAttempts: 3`, `baseMs: 500`, `maxMs: 30_000`, `jitter: true`. Composable with everything that takes a provider — `runAgent`, `runSpecialist`, `orchestrate`, channel handlers — none of them know it exists. ADR 0007.

### The tool loop

`src/agent/run.ts` exposes `runAgent({ llm, model, system, tools, messages })`. The loop:

1. `llm.complete()` with current messages + tools.
2. Append assistant response.
3. If `stopReason === "tool_use"`: run all `tool_use` blocks concurrently via `Promise.all`, append `tool_result` messages, loop.
4. Otherwise: return.

Bounded by `maxIterations` (default 5). No confirmation gate, no concurrency limit, no formatGuide — those are all things to *grow into* if/when the abstraction proves out, not things to retrofit prematurely.

`RunAgentResult.usage: Usage` reports cumulative `{ inputTokens, outputTokens }` summed across every iteration's `complete()` (or `message_stop` event for `streamAgent`). `Classification.usage` carries the single router-call cost. `OrchestrateResult` adds `routerUsage` + `specialistUsage` and the inherited `usage` is the sum — cheap to wire metering on top, no double-accounting. `addUsage` / `zeroUsage` are exported helpers. Cost mapping is left to the consumer (per-model rate tables are user-space).

**Tool limits.** `ToolDef` has two opt-in defensive caps. `timeoutMs?: number` wraps the handler in a timeout race; on expiry the tool result is `[TIMEOUT] Tool exceeded ${ms}ms` with `isError: true`, mirroring `[DECLINED]`. Note: timeout does *not* cancel the underlying handler promise — the bg work keeps running. Handlers that need real cancellation must take their own signal; adding `signal` to `ToolContext` is intentionally deferred. `maxResultBytes?: number` caps the handler's return string by UTF-8 byte length (via `TextEncoder`); when exceeded, the content is truncated on the byte boundary (decoded with `fatal: false` so a split multibyte char doesn't throw) and `\n\n[TRUNCATED: N of M bytes]` is appended. Truncation is `isError: false` — it's a cap, not a failure. Both knobs are no-default opt-in; consumers set per-tool. Wrapped at the single `runHandler` chokepoint, so `runAgent`, `resumeAgent`, and `streamAgent` all inherit the behaviour.

### Streaming

`LLMProvider` exposes a parallel `stream(req, { signal? })` method returning `AsyncGenerator<StreamEvent>`. `complete()` is unchanged — buffered consumers pay no SSE-parsing tax. `streamAgent` (and `streamSpecialist`) yield `AgentEvent`s that interleave provider deltas with `tool_dispatch_start`/`tool_dispatch_done` and a final `agent_done`. `orchestrate` and the channel layer stay buffered. ADR 0004 records the decisions: scope = provider + runAgent, parallel methods (not unified-on-stream), normalized provider-shape events, AsyncGenerator API. Both adapters share `src/llm/sse.ts`. Both expose internal `streamFromAnthropicSSE` / `streamFromOpenAISSE` async generators that the tests target directly — no `globalThis.fetch` shimming.

### Orchestration layer

Phase 2 added a thin router → specialist → tool stack on top of `runAgent`:

- `ToolContext<TServices>` (`src/agent/context.ts`) — opaque dict of `services` threaded into every tool handler. Proteus never inspects it.
- `Specialist<TServices>` (`src/agent/specialist.ts`) — `{ name, description, role, tools, model? }`. `runSpecialist` invokes `runAgent` with the specialist's `role` as the system prompt and its tools.
- `classifyIntent` (`src/agent/router.ts`) — single LLM call, low temperature, returns the chosen intent name. Three-tier matching: exact → substring containment (longest-name-first) → fallback. Reads `text` blocks, falls back to `reasoning` blocks if text is empty (handles thinking models like GLM that consume `maxTokens` on reasoning before producing content).
- `orchestrate` (`src/agent/orchestrate.ts`) — `classifyIntent` → pick specialist → `runSpecialist`. Caller passes separate `routerModel` and `specialistModel` so cheap routing + capable specialist is one config away.

Hard rule unchanged: nothing in `src/agent/` may import an adapter file. Only `src/llm/types.ts` and `src/llm/provider.ts`.

History caveat: `OrchestrateOpts.history` should contain only `user` and plain-text `assistant` messages. Tool transcripts from a prior specialist are unsafe to re-feed because tool ids won't match the next specialist's schema.

### Confirmation gate

Per-tool opt-in destructive-action gating. A tool author marks a `ToolDef` with `requiresConfirmation: true` and (optionally) `summarize(input) => string`. The agent loop intercepts before invoking the handler: if the consumer supplied a `ConfirmCallback`, it is awaited; declined calls short-circuit to a `tool_result` whose content begins `[DECLINED] User declined this action: <summary>` (a stable marker so prompts/evaluators don't have to parse English). No global `WRITE_TOOLS` registry — each tool declares its own write-ness.

Threading: `RunAgentInput.confirm` → `RunSpecialistOpts.confirm` → `OrchestrateOpts.confirm` → `ChatHandlerConfig.confirm`. `ToolContext` is deliberately *not* extended; gating is framework-mediated, not handler-mediated.

Concurrency: confirms within a single turn are serialized in tool-block order (one prompt at a time); approved handlers then run via `Promise.all`. Consumers wanting parallel confirms can wrap their callback themselves.

Streaming: `streamAgent` emits `tool_confirm_request` (with `summary`) and `tool_confirm_response` (with `confirmed: boolean`) around each gate. Observation-only — gating uses the callback. No `tool_dispatch_start` is yielded for declined tools.

Scope: in-process callback works for CLI (`demo/confirm.ts`) and Telegram long-poll (`demo/telegram-confirm.ts`, in-memory `Map<toolUseId, resolve>` + inline buttons). For HTTP single-shot request/response, see "HTTP suspend/resume" below — `confirm` returning the new `"pending"` literal is the bridge. Streaming (`streamAgent`, SSE chat handler) does **not** support `"pending"` — a `"pending"` decision there throws. Durable pending-action queues / cross-process resume scaffolding beyond the simple `PendingStore` shape are explicitly not provided.

### HTTP suspend/resume

`ConfirmCallback` may return `"pending"` in addition to `boolean`. When it does, `runAgent` exits early with `stopReason: "pending"` and a `suspended: SuspensionPayload` capturing the pre-turn messages, the assistant turn's `turnContent`, the per-tool `decided` map, and the iteration count. `resumeAgent({ suspended, resume: { toolUseId, decision } })` rebuilds the loop state, applies the decision, dispatches the rest of the turn, and re-enters the main loop where it left off (may itself suspend again on the next confirm-required tool — supported, one roundtrip per gate).

`resumeSpecialist` and `resumeOrchestrate` mirror their fresh counterparts but skip the router — the chosen specialist is locked in the persisted record. Re-routing on resume would be wrong; the user is responding to a specific offer.

Channel: `createChatHandler` config gains `pendingStore?: PendingStore` (sibling of `SessionStore`, separate lifecycle). When set, the effective `confirm` always returns `"pending"`, suspensions are persisted to `pendingStore`, and `ChatResponse` becomes `{ kind: "reply", ... } | { kind: "pending", toolUseId, name, summary, routedTo }`. `ChatRequest.confirm?: { decision }` resolves a stored pending; with no decision the same pending re-surfaces (no LLM call). Persistence rule from ADR 0002 unchanged: `SessionStore` only sees the user/assistant text pair. The streaming chat handler does not support suspend/resume in v1. ADR 0008.

### Channel layer

`src/channel/` is the first non-LLM abstraction. Two pieces:

- `SessionStore` (`store.ts`) — `{ get, append }` interface keyed by `sessionId`. `inMemoryStore()` ships as the default, with per-session serialization to keep concurrent appends ordered. Real backends (Postgres/Redis) implement the same two methods.
- `createChatHandler` (`http.ts`) — pure function-shaped handler `(req) => Promise<ChatReply | ChatPending>`. No HTTP framework dep; consumers wrap it. Persists only the user/assistant text pair, never tool transcripts (per ADR 0002). Suspend/resume opt-in via `pendingStore` config; without it the handler returns `{ kind: "reply" }` always.
- `inMemoryPendingStore()` (`pending.ts`) — `{ get, set, clear }` interface for the suspended-confirm record. One pending per session.
- `createStreamingChatHandler` (`http.ts`) — streaming sibling. Returns `(req, { signal? }) => AsyncGenerator<ChatStreamEvent>` yielding `routed`, `text_delta`, and a terminal `done`. Internal `AgentEvent`s (tool_dispatch, reasoning, message_start/stop) are intentionally not forwarded — drop down to `streamOrchestrate` if you need them. Persistence rule unchanged from the buffered handler. ADR 0005 records the design.
- `telegram.ts` — `processUpdate(update, deps)` for pure update mapping plus two transports: `runPolling(opts)` (long-poll, default for PoC/local) and `createWebhookHandler(opts)` (returns `(req) => { status, body? }`, validates `X-Telegram-Bot-Api-Secret-Token` when configured). Accepts either Web `Headers` or a plain header dict. ADR 0003 records the long-poll-first decision.

ADRs in `docs/adr/` track load-bearing channel-layer decisions. New decisions go there as numbered files; style choices stay in this file.

## What does *not* belong here yet

The PoC is deliberately minimal. None of the following exist or should be added without a concrete reason driven by a real consumer:

- Caching strategy / cache breakpoint hints
- Usage / cost tracking
- Telegram message-edit streaming (HTTP SSE landed in ADR 0005; Telegram has its own rate-limit problem and stays deferred)
- HTTP suspend/resume for confirm gate (in-process callback only today)
- Auto-retry / backoff layer on top of the typed error hierarchy
- Additional adapters beyond the two protocol shapes
- Multi-specialist chain/parallel orchestration modes
- Evaluator (response quality gate)

If a future task asks for one of these, the right move is usually to push back: confirm there's a real call site that needs it before adding it. The PoC's value is in being small enough that the abstraction is legible.

## Configuration model

The demo selects a provider via `PROVIDER=anthropic|compat` env var. Then:

- `anthropic`: reads `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (optional).
- `compat`: reads `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`. The base URL points at any OpenAI-compatible host (Groq, Together, Cerebras, OpenRouter, Ollama, LM Studio, Vercel AI Gateway, etc.). The user brings their own key and chooses their model.

The framework deliberately doesn't ship preset hosts or model id constants — that's user-space concern.

## Project context (relevant for design decisions)

Proteus is being extracted from `~/Desktop/intrebit/agents` (a CRM-coupled production agent system). The goal is a clean OSS framework that the intrebit codebase will eventually consume as a dep. When making design decisions, lean toward the *generic* shape; CRM-specific concerns belong in the consumer, never here.

The intrebit repo is the reference for "what production needs look like" — read `intrebit/agents/operator/src/claude/specialists/base.ts` and `intrebit/agents/core/src/anthropic.ts` if you need prior art for tool loops or Anthropic translation.
