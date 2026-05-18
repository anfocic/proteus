# Proteus

**Write your agent once. Run it against any LLM.**

[![CI](https://github.com/anfocic/proteus/actions/workflows/ci.yml/badge.svg)](https://github.com/anfocic/proteus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

Proteus is a small TypeScript framework for building LLM agents. You wire up your tools, your system prompt, and your messages. Proteus runs the tool loop, handles streaming, routes between specialists, and gates destructive actions. The model vendor underneath is swappable — Claude one day, Groq the next, a local Ollama for dev — without touching your agent code.

It's about 3,500 lines, has no runtime dependencies, and you can read all of it in an afternoon.

## What it looks like

```ts
import { anthropic, runAgent } from "@fole/proteus";

const llm = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const result = await runAgent({
  llm,
  model: "claude-sonnet-4-6",
  system: "You're a weather assistant. Be brief.",
  messages: [{ role: "user", content: "What's it like in Berlin?" }],
  tools: [{
    name: "get_weather",
    description: "Current weather for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    handler: async ({ city }) => `${city}: 18°C, light rain`,
  }],
});

console.log(result.finalText);
//=> "Berlin's at 18°C with light rain right now."
```

Want to run that against Groq instead? Swap two lines:

```ts
import { openaiCompat } from "@fole/proteus";

const llm = openaiCompat({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});
// runAgent({ llm, model: "llama-3.3-70b-versatile", ... }) — everything else is identical.
```

That's the whole pitch.

## Why two adapters is enough

Every LLM API in the wild is one of two shapes:

- **Anthropic-shape** — content blocks, `tool_use` / `tool_result` as blocks.
- **OpenAI-compat shape** — flat strings, `tool_calls` array, `role: "tool"` messages.

Claude is the first. OpenAI, Groq, Together, Cerebras, OpenRouter, Fireworks, DeepInfra, Ollama, LM Studio, vLLM, Vercel AI Gateway, and basically every other host (including Gemini and Mistral via their compat endpoints) are the second. Proteus normalizes both behind one `LLMProvider` interface. Two thin adapters translate to and from the wire format. Everything above them — the tool loop, the router, the channels — never knows which vendor is on the other side.

You bring your own API key and pick your own model id. The framework ships no preset hosts and no model constants.

## Install

```sh
npm install @fole/proteus
```

Requires Node 22 or newer.

## What you get

| You can | Using |
|---|---|
| Run a tool-using agent against any model | `runAgent` |
| Stream output token by token, with tool events interleaved | `streamAgent` |
| Split your agent into specialists and route between them | `orchestrate` — `single`, `chain`, or `parallel` mode |
| Gate destructive tools behind a "yes / no / ask later" prompt | `requiresConfirmation` + `ConfirmCallback` |
| Pause an agent over HTTP and resume on the next request | `stopReason: "pending"` + `resumeAgent` |
| Retry the flaky calls and not the broken ones | `withRetry` — composes with anything |
| Catch errors by type instead of parsing strings | `LLMAuthError`, `LLMRateLimitError`, `LLMServerError`, … |
| Cancel a slow tool when the agent is aborted | `ctx.signal` inside the handler |
| Track tokens (including Anthropic cache hits) at every layer | `Usage` aggregated automatically |
| Drop into Express, Hono, Cloudflare Workers, Telegram, … | `createChatHandler`, `createStreamingChatHandler`, Telegram polling + webhook |

All composable. None of it is required — start with `runAgent` and grow into the rest.

## Run the demos

Clone the repo, then:

```sh
npm install
cp .env.example .env       # fill in the host you want to use
```

| Command | What it shows |
|---|---|
| `PROVIDER=compat npm run demo` | Single tool call. Model asks for weather, calls the tool, summarizes. |
| `PROVIDER=anthropic npm run demo` | Same agent code, Anthropic instead. The point is that nothing else changes. |
| `npm run demo:multi` | Multiple tools in one turn, dispatched concurrently. |
| `npm run demo:triage` | Router → specialist orchestration. |
| `npm run demo:confirm` | Confirmation gate on a destructive tool. |
| `npm run demo:stream` | Streaming agent output. |
| `npm run demo:chat` / `demo:chat-stream` | HTTP chat handler, buffered and streaming. |
| `npm run demo:telegram` / `demo:telegram-confirm` | Telegram transport, with and without the confirm gate. |

Any OpenAI-compatible host works — set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in `.env`. The `.env.example` has snippets for Groq, Together, Cerebras, OpenRouter, Ollama, and LM Studio.

## The one rule

Agent and framework code (`src/agent/`, `src/channel/`) imports only `src/llm/types.ts` and `src/llm/provider.ts`. **Never an adapter file.** Provider construction happens in user code. Break that line and the abstraction stops being abstract.

For the deeper architecture, `CLAUDE.md` is the reference. Load-bearing decisions live as numbered ADRs in `docs/adr/`.

## Status

Pre-1.0. Everything in the table above is in and tested (230+ tests, all mock-driven so they run without API keys). The API may shift between minor versions until things settle.

What's queued vs. deliberately out of scope lives in `ROADMAP.md`.

## License

MIT
