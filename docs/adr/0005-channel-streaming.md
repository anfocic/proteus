# 0005 — Channel-layer streaming: HTTP SSE handler, router stays buffered

- **Status**: Accepted
- **Date**: 2026-05-03

## Context

ADR 0004 wired streaming through `LLMProvider.stream` → `streamAgent` → `streamSpecialist` but explicitly stopped there: "channel-layer streaming is a separate decision when there's a real call site for it." That call site is now the obvious next step — chat clients consuming `createChatHandler` cannot surface tokens as they arrive.

Three sub-decisions:

1. Does the router stream?
2. What event shape does the channel expose?
3. Does the channel ship a byte serializer (SSE framing) or just a generator?

## Decision

**Router stays buffered.** `streamOrchestrate` calls `classifyIntent` (which calls `complete`), yields a single `routed` event, then delegates to `streamSpecialist`. Routing is one short, low-temperature call that returns an intent name; nothing useful streams from it. Same reasoning as ADR 0004's "scope: provider + runAgent only" — extended one rung up.

**Minimal client-facing event set in `ChatStreamEvent`.** Three variants only:

- `{ type: "routed"; routedTo }` — leading event, lets clients show a "routed to weather" pill before tokens arrive.
- `{ type: "text_delta"; text }` — assistant tokens for client UI.
- `{ type: "done"; reply; routedTo }` — terminal event with the full assembled reply.

Internal `AgentEvent` variants (`tool_dispatch_start/done`, `reasoning_delta`, `message_start/stop`, `tool_use_start/stop`) are **not** forwarded. A chat client doesn't need them. Consumers that do (debug tooling, observability) can call `streamOrchestrate` directly — it returns the full union.

**No SSE byte serializer.** `createStreamingChatHandler` returns an `AsyncGenerator<ChatStreamEvent>`, mirroring `createChatHandler` returning a plain Promise. Consumers wrap it. The demo shows the wrapper is five lines: `for await ... res.write(\`data: ${JSON.stringify(ev)}\n\n\`)`. Shipping a byte serializer would lock in a transport (SSE vs WebSocket vs ND-JSON) and a JSON framing decision — premature without a real consumer asking for it.

**Persistence rule unchanged.** On `agent_done` the handler appends exactly the `[user, assistant{text}]` pair, same as the buffered handler. Tool transcripts are never persisted (ADR 0002 still binding).

**AbortSignal threads top-to-bottom.** Handler accepts `{ signal? }`, `streamOrchestrate` forwards to `streamSpecialist`, which forwards to `streamAgent`, which forwards to `LLMProvider.stream`. On abort the generator throws `AbortError` and persistence is skipped (the `agent_done` branch never runs).

## Consequences

**Buys**
- Real token-by-token UX through the channel layer with no extra dependencies.
- Existing `createChatHandler` is untouched. Buffered consumers pay no streaming tax.
- The hard architectural invariant survives — `src/agent/` and `src/channel/` still import only from `src/llm/types.ts` + `src/llm/provider.ts`.
- Reuses `streamSpecialist` and the existing `inMemoryStore` serialization logic. The new code is one new function in `orchestrate.ts` (~25 lines) plus one new function in `http.ts` (~35 lines).

**Costs**
- Two parallel handler factories to maintain (`createChatHandler` ↔ `createStreamingChatHandler`). They share a config type so config-shape changes still touch one place.
- The minimal `ChatStreamEvent` set means a UI that wants to show "tool running…" indicators needs to drop down to `streamOrchestrate`. Acceptable: that consumer doesn't exist yet, and exposing tool-dispatch boundaries on the chat handler later is additive.

**Locks out**
- Nothing. WebSocket / ND-JSON / per-tool latency surfacing / mid-stream tool confirmation can all be added later without changing the existing surface.

## Hazards consumers must know

Aborting mid-stream throws and orphans the `routed` event without a matching `done`. Consumers maintaining partial UI state must abandon it on throw — same hazard ADR 0004 records for the agent layer.

`reply` on the `done` event is the assistant text *as the agent assembled it*, not necessarily the literal concatenation of `text_delta` payloads if the agent ran multiple iterations (text from earlier iterations is replaced by the final-iteration text). For chat UIs that render deltas live, the safest pattern is: clear the in-progress buffer and render `done.reply` on terminal event.

## Out of scope (deliberately)

- Telegram message-edit streaming. Different problem (Telegram rate limits, message-edit throttling, sequence collapsing). Stays deferred.
- WebSocket transport. Add when a consumer needs bidirectional.
- ND-JSON / JSON-Lines transport. Add when a non-SSE consumer surfaces.
- Surfacing `tool_dispatch_start/done` to clients. Add when a UI needs it.
- Usage / cost surfacing in the stream. Tracked separately on the agent ADR follow-up.
