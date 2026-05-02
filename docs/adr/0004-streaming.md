# 0004 — Streaming: provider + runAgent only, parallel methods, normalized events

- **Status**: Accepted
- **Date**: 2026-05-02

## Context

Real consumers (chat surfaces, the in-tree Telegram channel, future intrebit integration) want token-by-token UX. Existing `LLMProvider.complete()` and `runAgent()` are buffered: nothing reaches the consumer until the whole response is assembled. CLAUDE.md listed streaming as deferred, but there's now a concrete call site asking for it.

Three independent design questions:

1. How far up the stack does streaming reach?
2. Modify existing methods or add parallel ones?
3. Provider-shape events or some custom DSL?

## Decision

**Scope: provider + runAgent only.** `orchestrate` and the channel layer stay buffered. Routing is one cheap LLM call; channel persistence stores the final reply text per ADR 0002 and doesn't care about deltas. Channel-layer streaming is a separate decision when there's a real call site for it.

**Parallel methods, not unified-on-stream.** `complete()` stays bit-identical. New `stream()` lives next to it on `LLMProvider`. New `streamAgent()` lives next to `runAgent()`. The buffered path remains the simplest possible implementation; consumers paying for non-streaming calls don't pay an SSE-parsing tax.

**Normalized provider-shape events** (`StreamEvent` union mirroring Anthropic's clean lifecycle): `message_start`, `text_delta`, `reasoning_delta`, `tool_use_start`, `tool_use_stop`, `message_stop`. The OpenAI-compat adapter assembles its delta-with-indices wire shape into the same events. The agent layer never sees raw provider events.

`message_stop` carries the **assembled** `ContentBlock[]` so the tool loop never re-parses partial JSON. `tool_use_stop` carries parsed input on close. No `tool_use_delta` exposed (adapter accumulates internally). No `text_start`/`text_stop` block-boundary events (`index` change is sufficient signal). No `iteration_start`/`iteration_end` agent events (1:1 with `message_start`/`message_stop`).

`stream()` returns `AsyncGenerator<StreamEvent, void, void>` and accepts `{ signal?: AbortSignal }` as a second arg. `streamAgent()` returns `AsyncGenerator<AgentEvent, RunAgentResult, void>` where `AgentEvent` extends `StreamEvent` with `tool_dispatch_start`, `tool_dispatch_done`, and `agent_done`.

`complete()` is unchanged — no signal arg, no behaviour change.

## Consequences

**Buys**
- Real token-by-token UX. `streamAgent` consumers see provider deltas plus tool-loop boundaries in a single stream.
- Adapters stay thin: each gets ~75–90 LOC of streaming code on top of the existing translation logic. Existing `complete()` paths and translation helpers (`fromAnthropicBlock`, `mapStopReason`, `mapFinishReason`) are reused inside the streaming path.
- The hard architectural invariant survives: `src/agent/` still imports only `src/llm/types.ts` + `src/llm/provider.ts`. `streamAgent` reuses the same shared `dispatchTool` helper as `runAgent`.

**Costs**
- Two parallel APIs to maintain (`complete` ↔ `stream`, `runAgent` ↔ `streamAgent`). The alternative — unifying around streaming-only — would force every buffered call site to drain a stream for a one-shot completion.
- A new `src/llm/sse.ts` helper. ~50 LOC, zero deps, shared between adapters.
- `LLMProvider.stream()` is required, not optional. Any external `LLMProvider` impl breaks. No external impls today; this is a private PoC.

**Locks out**
- Nothing. Channel-layer streaming, error taxonomy, retry, mid-stream confirmation gates can all be added later without touching this design.

## Hazards consumers must know

A thrown stream may have emitted `tool_use_start` (or any other "start" event) without a matching `tool_use_stop`. Consumers that maintain partial UI state must **abandon partial state on throw** — there is no resume. Streaming is best-effort: if the connection drops mid-`message_stop`, the assembled `content` for that turn is lost and the consumer must treat the iteration as failed.

The `Promise.all` parallel tool dispatch matches the existing `runAgent` shape: all `tool_dispatch_done` events arrive after all tools settle, in dispatch order. Consumers that need per-tool completion latency surfaced individually need a different shape — defer until a real call site asks.

## Out of scope (deliberately)

- Error taxonomy (`LLMError`). Adapters still throw raw `Error`.
- Retry / backoff. Streaming makes retries harder to reason about; defer until a consumer needs it.
- Mid-stream tool confirmation gates. Tool dispatch is fire-and-forget per the existing `runAgent` model.
- Channel-layer streaming (HTTP SSE response, Telegram message-edit streaming). No real call site yet.
- Anthropic `thinking` block support. Proteus's `ContentBlock` doesn't yet model thinking; streaming variant ignores `thinking_delta` events the same way `complete()` ignores them today.
