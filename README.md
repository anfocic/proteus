# Proteus

Provider-agnostic agent framework. Proof of concept.

One `LLMProvider` interface, two adapters covering the two structurally distinct LLM API shapes:

- `anthropic` — Anthropic Messages API (content blocks, `tool_use` / `tool_result` blocks)
- `openaiCompat` — OpenAI-style `/chat/completions` (the protocol spoken by Groq, Together, Cerebras, OpenRouter, Fireworks, DeepInfra, Ollama, LM Studio, vLLM, Vercel AI Gateway, and basically every OSS-model host)

The same agent code runs against either. Bring your own API key and base URL.

## Zero runtime dependencies

The framework imports nothing. Both adapters use `fetch` directly. Install size is dev-tooling only.

## Run the demo

```sh
npm install
cp .env.example .env       # fill in the host you want to use
PROVIDER=compat    npm run demo
PROVIDER=anthropic npm run demo
```

The demo asks for the weather, the model calls a `get_weather` tool, and the model summarises the result.

### Pointing at OSS models

Any OpenAI-compatible host works. Set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in `.env`. See `.env.example` for examples (Groq, Together, Cerebras, OpenRouter, Ollama, LM Studio).

## Status

PoC. No router, no specialists, no channels, no caching, no streaming. Just the abstraction and proof it works against two structurally different LLM API shapes.
