# 0001 — HTTP-shaped channel adapter before Telegram

- **Status**: Accepted
- **Date**: 2026-05-02

## Context

Phase 3 introduces the first channel adapter — the surface that turns inbound user messages into `orchestrate(...)` calls and outbound replies. Two real candidates:

1. **HTTP** (raw `fetch`-style handler, no framework dep).
2. **Telegram** (the channel `intrebit/agents` actually uses in production).

Telegram is the production target, so picking it directly looks pragmatic. Counter-argument: Telegram couples the handler to a vendor SDK and webhook semantics, hiding which parts of the design are channel-shaped vs. Telegram-shaped. A wrong abstraction at this layer infects every future adapter (Slack, HTTP, CLI, WhatsApp).

## Decision

Build the HTTP adapter first, as a pure function-shaped handler:

```ts
createChatHandler<TServices>({ ...orchestrateConfig, store })
  → (req: { sessionId: string; message: string }) => Promise<{ reply: string; routedTo: string }>
```

No framework integration (Express/Hono/Fastify). Consumers wrap it. Telegram lands later as a thin wrapper that maps Telegram update → `{ sessionId, message }` and posts the reply back via `sendMessage`.

## Consequences

**Buys**
- Forces the channel/orchestration boundary to be pure data (`{ sessionId, message }`). No webhook signatures or SDK types leak into core.
- Trivially testable: call the handler directly, no HTTP server.
- Telegram, Slack, CLI all become single-file wrappers with no new runtime deps.

**Costs**
- One extra hop for the production target. Telegram lands one PR later, not zero.
- No streaming over Server-Sent Events / WebSockets. Acceptable: `LLMProvider` doesn't stream either, deferred to a later phase.

**Locks out**
- True bidirectional / push-from-server flows (server initiates a message). Out of scope for now; fits a different abstraction (event emitter, not request/response).
