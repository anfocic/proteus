# 0002 — Pluggable `SessionStore` for channel history

- **Status**: Accepted
- **Date**: 2026-05-02

## Context

The channel adapter (ADR 0001) needs to thread conversation history per `sessionId` into `orchestrate(...)`. Three places it could live:

1. **Caller's problem** — handler is stateless, caller passes `history` each call. Pushes complexity to every consumer.
2. **Hardcoded in-memory `Map`** — simple, ships, but unusable across processes / restarts.
3. **Pluggable interface with an in-memory default** — small contract, real backends slot in.

Production needs at least Postgres or Redis. Tests need isolation per case. CLI demos want zero setup.

`OrchestrateOpts.history` already carries the cross-specialist tool-transcript caveat (only `user` + plain-text `assistant` is safe). The store must respect that — it stores what's safe to re-feed, not raw transcripts.

## Decision

Define a tiny `SessionStore` interface:

```ts
interface SessionStore {
  get(sessionId: string): Promise<Message[]>;
  append(sessionId: string, msgs: Message[]): Promise<void>;
}
```

Ship `inMemoryStore()` as the default. The handler:

1. `history = await store.get(sessionId)`
2. `result = await orchestrate({ ..., message, history })`
3. `await store.append(sessionId, [{role:"user",content:message}, {role:"assistant",content:[{type:"text",text:result.finalText}]}])` — only the safe-to-re-feed pair, **not** the tool-call middle.

Concurrency: `inMemoryStore` serializes `append` per `sessionId` via a `Map<sessionId, Promise>` chain. Real backends do their own locking (row lock, Redis `WATCH`, etc.). The interface stays oblivious; correctness is the impl's problem.

## Consequences

**Buys**
- Backends are opt-in: zero-setup demos work, prod plugs in Postgres/Redis without touching channel code.
- The store-only-safe-pairs rule is enforced at exactly one site (the handler), not scattered across consumers.
- Tests use a fresh `inMemoryStore()` per case — no global state to reset.

**Costs**
- First non-LLM abstraction in the framework. Increases surface by two methods. Justified because every channel needs history; pushing it to consumers means every consumer reinvents it.
- `append` taking an array is mildly more awkward than `appendUser` + `appendAssistant`, but keeps writes atomic per turn.

**Locks out**
- Sub-conversation branching (think tree-of-thought UIs). A linear-history store can't model that. Out of scope; revisit if a real consumer needs it.
- Streaming partial-assistant writes. Append happens once at end-of-turn. Fine for non-streaming PoC.
