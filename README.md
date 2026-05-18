# Proteus

**Provider-agnostic LLM agent framework.** Write your agent once; run it against Anthropic or any OpenAI-compatible host without touching agent code.

[![CI](https://github.com/anfocic/proteus/actions/workflows/ci.yml/badge.svg)](https://github.com/anfocic/proteus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

## The idea

Every LLM API in the ecosystem is one of two structurally distinct shapes:

- **Anthropic shape** — content blocks, `tool_use` / `tool_result` as blocks.
- **OpenAI-compat shape** — flat string content, `tool_calls` array, `role: "tool"` messages.

Gemini, Mistral, Cohere, and every OSS-model host are variants of one of these two. Proteus normalizes both behind a single `LLMProvider` interface with one method, `complete(req)` (plus a parallel `stream(req)`). Two thin adapters fold the normalized shape back to each wire format. Everything else — the tool loop, routing, channels — is built on that one interface and never sees a vendor.

You bring your own API key and base URL. The framework ships no preset hosts and no model-id constants — that's user-space.

## Zero runtime dependencies

The framework imports nothing. Both adapters call `fetch` directly. Your `node_modules` is dev tooling only.

## What's in the box

| Layer | What it gives you |
|---|---|
| **Adapters** | `anthropic` and `openaiCompat` — the two protocol shapes. Works with Groq, Together, Cerebras, OpenRouter, Fireworks, DeepInfra, Ollama, LM Studio, vLLM, Vercel AI Gateway, and every other OpenAI-compatible host. |
| **Tool loop** | `runAgent` — concurrent tool dispatch, bounded iterations, per-tool `timeoutMs` and `maxResultBytes` caps, optional concurrency limit. |
| **Streaming** | Parallel `stream()` method and `streamAgent` — provider deltas interleaved with tool-dispatch events. Buffered consumers pay no SSE tax. |
| **Orchestration** | `classifyIntent` router → `Specialist` → tool stack. `orchestrate` supports `single`, `chain` (A's output feeds B), and `parallel` (fan-out, merge) modes, plus an optional evaluator quality-gate. |
| **Confirmation gate** | Per-tool opt-in destructive-action gating. In-process callback for CLI/Telegram; HTTP suspend/resume (`stopReason: "pending"` + `resumeAgent`) for single-shot request/response. |
| **Errors + retry** | Typed `LLMError` hierarchy (auth, rate-limit, bad-request, server, transport, stream). `withRetry` wraps any provider with full-jitter exponential backoff — composable, nothing downstream knows it exists. |
| **Channels** | `SessionStore` abstraction + `createChatHandler` (buffered and streaming, framework-agnostic) + Telegram long-poll and webhook transports. |
| **Caching + metering** | Anthropic prompt-caching hints (system prompt, tools, specialist roles). Cache-token usage metered on `Usage` and aggregated through the whole stack. |

## Install

```sh
npm install @fole/proteus
```

Requires Node 22+.

## Run the demos

Clone the repo, then:

```sh
npm install
cp .env.example .env       # fill in the host you want to use
```

| Command | What it shows |
|---|---|
| `PROVIDER=compat npm run demo` | Single tool call — model asks for weather, calls the tool, summarizes. |
| `PROVIDER=anthropic npm run demo` | Same agent code, Anthropic instead. The abstraction holding is the point. |
| `npm run demo:multi` | Multiple tools in one turn, dispatched concurrently. |
| `npm run demo:triage` | Router → specialist orchestration. |
| `npm run demo:confirm` | Confirmation gate on a destructive tool. |
| `npm run demo:stream` | Streaming agent output. |
| `npm run demo:chat` / `demo:chat-stream` | HTTP chat handler, buffered and streaming. |
| `npm run demo:telegram` / `demo:telegram-confirm` | Telegram transport, with and without the confirm gate. |

Any OpenAI-compatible host works — set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in `.env`. See `.env.example` for Groq, Together, Cerebras, OpenRouter, Ollama, and LM Studio examples.

## Architecture

One load-bearing rule: agent and framework code (`src/agent/`, `src/channel/`) may import only `src/llm/types.ts` and `src/llm/provider.ts` — **never an adapter file**. Provider construction happens in user code. Breaking that invariant defeats the whole abstraction.

`CLAUDE.md` is the architecture reference; load-bearing decisions are recorded as numbered ADRs in `docs/adr/`.

## Status

Proof of concept. The provider abstraction, both adapters, the tool loop, streaming, the full router → specialist → orchestrate stack, the confirmation gate with HTTP suspend/resume, typed errors, retry, channels, and caching hints are all in and tested (200+ tests, mock-driven, no live hosts needed).

Published as `@fole/proteus`; pre-1.0, so the API may shift between minor versions until it stabilizes. `ROADMAP.md` tracks what's queued and what's deliberately out of scope.

## License

MIT
