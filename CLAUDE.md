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

### The tool loop

`src/agent/run.ts` exposes `runAgent({ llm, model, system, tools, messages })`. The loop:

1. `llm.complete()` with current messages + tools.
2. Append assistant response.
3. If `stopReason === "tool_use"`: run all `tool_use` blocks concurrently via `Promise.all`, append `tool_result` messages, loop.
4. Otherwise: return.

Bounded by `maxIterations` (default 5). No confirmation gate, no concurrency limit, no formatGuide — those are all things to *grow into* if/when the abstraction proves out, not things to retrofit prematurely.

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

### Channel layer

`src/channel/` is the first non-LLM abstraction. Two pieces:

- `SessionStore` (`store.ts`) — `{ get, append }` interface keyed by `sessionId`. `inMemoryStore()` ships as the default, with per-session serialization to keep concurrent appends ordered. Real backends (Postgres/Redis) implement the same two methods.
- `createChatHandler` (`http.ts`) — pure function-shaped handler `({ sessionId, message }) => { reply, routedTo }`. No HTTP framework dep; consumers wrap it. Persists only the user/assistant text pair, never tool transcripts (per ADR 0002).
- `telegram.ts` — `processUpdate(update, deps)` for pure update mapping plus two transports: `runPolling(opts)` (long-poll, default for PoC/local) and `createWebhookHandler(opts)` (returns `(req) => { status, body? }`, validates `X-Telegram-Bot-Api-Secret-Token` when configured). Accepts either Web `Headers` or a plain header dict. ADR 0003 records the long-poll-first decision.

ADRs in `docs/adr/` track load-bearing channel-layer decisions. New decisions go there as numbered files; style choices stay in this file.

## What does *not* belong here yet

The PoC is deliberately minimal. None of the following exist or should be added without a concrete reason driven by a real consumer:

- Channel adapters (Telegram, HTTP, etc.)
- Confirmation gate / WRITE_TOOLS taxonomy
- Caching strategy / cache breakpoint hints
- Usage / cost tracking
- Channel-layer streaming (HTTP SSE response, Telegram message-edit streaming)
- Error taxonomy (`LLMError` class — adapters currently throw raw `Error`)
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
