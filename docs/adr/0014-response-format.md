# 0014 — Structured output (`responseFormat`)

- **Status**: Accepted
- **Date**: 2026-05-18

## Context

Both supported provider shapes have first-class JSON-output modes:

- **OpenAI-compat** — `response_format: { type: "json_object" }` for any-valid-JSON, or `{ type: "json_schema", json_schema: { name, schema, strict } }` for schema-enforced output. Streaming works unchanged (tokens still arrive via content deltas).
- **Anthropic** — no equivalent native field. Two workarounds exist: (a) **prompt-only** — append schema instructions to the system prompt and trust the model; (b) **tool-use coercion** — define a synthetic tool with the schema and force it via `tool_choice`, which is more reliable but emits `input_json_delta` instead of `text_delta` and breaks `streamAgent` consumers expecting text.

Today, the only structured-output flow in the framework is `router.ts`, which hand-rolls the prompt-only approach internally (bakes JSON instructions + an example into the system prompt, sets `temperature: 0`, relies on `tryParseJSON` to repair the response). Consumers wanting their own JSON output have to duplicate that work.

`responseFormat` promotes the same capability to a first-class field on `CompletionRequest`. Both adapters honour it; what they do under the hood differs per provider.

This is the second deliberately-asymmetric provider field, after `cacheSystemPrompt` (ADR 0010). The same trade-offs apply: the user's call site stays vendor-agnostic; the adapter handles the divergence.

## Decision

### Wire format

`CompletionRequest` gains:

```ts
responseFormat?: ResponseFormat;

type ResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      name?: string;                     // surfaced to OAI, ignored by Anthropic
      schema: Record<string, unknown>;   // JSON Schema
      strict?: boolean;                  // forwarded as OAI `json_schema.strict`
    };
```

Default `undefined` (treated as off).

### Adapter behaviour

**OpenAI-compat** (`src/llm/openai-compat.ts`):

- Maps directly to the native `response_format` field on the chat request body.
- `name` defaults to `"response"` when omitted.
- `strict` is forwarded only when set.

**Anthropic** (`src/llm/anthropic.ts`):

- **Prompt-only strategy** — `appendResponseFormatInstructions` appends a JSON-output directive to the system prompt:
  - `json_object` → "Respond with ONLY a valid JSON object. No prose, no markdown fences, no commentary."
  - `json_schema` → the same lede plus the schema rendered as pretty JSON, prefixed with "Schema:".
- No tool-use coercion in v1.

### Interaction with `cacheSystemPrompt`

The schema instructions are appended to the system prompt **before** `cache_control` is applied. The cache covers the full prompt the model sees. Changing the schema invalidates the cache, which is correct: a different schema is a different prompt.

Concretely in `anthropic.ts:buildBody`:

```ts
system: encodeSystem(
  appendResponseFormatInstructions(req.system, req.responseFormat),
  req.cacheSystemPrompt,
),
```

Order: append → cache-wrap. Reversing it would either bypass cache (cache_control on the original text, schema appended outside) or split the cache key wrong (cache_control inside a sub-block).

## Why this shape

- **Why not native tool-use coercion on Anthropic?** Streaming consumers subscribed to `text_delta` would see no output — only `tool_use_start`, `input_json_delta`, `tool_use_stop`. Every existing `streamAgent` integration that reads text would silently break. Prompt-only preserves the streaming contract; tool-use coercion is a future opt-in when there's a concrete consumer that wants enforced schemas and isn't streaming.
- **Why not a `strategy` parameter to let users pick?** Premature. The set of viable strategies is small (prompt-only, tool-use, future native if Anthropic adds it). Add the knob when there's a real second consumer; for now one default is one default.
- **`name` surfaced to OAI only.** Anthropic prompt-only has no use for it. Ignoring silently rather than throwing keeps the asymmetric-field convention.
- **`schema: Record<string, unknown>`, not a Zod / Valibot dep.** The framework has zero runtime deps. Schema validation belongs in user-space; consumers can construct the schema however they like (Zod's `zod-to-json-schema`, hand-rolled, generated, etc.).
- **`tryParseJSON` stays.** Anthropic prompt-only doesn't enforce; the local-model truncation case (LM Studio etc.) still needs repair. Router will continue to call `tryParseJSON` when it migrates to `responseFormat` (PR 4).

## What's NOT in scope

- **Anthropic tool-use coercion.** Deferred. Add when needed; reuse the same `responseFormat` field with an optional `strategy: "tool_use"` discriminator.
- **Validation against the schema** (server-side or client-side). The framework forwards the schema; the model decides whether to honour it; the consumer validates. AJV / Zod / etc. are user-space.
- **`responseFormat` on `Specialist`.** Most specialists return prose. Adding a per-specialist JSON-output sugar is easy when a real consumer needs it; not worth the API surface today.
- **Router refactor.** Splits into PR 4 so the prompt-drift diff is reviewable on its own.

## Consequences

`CompletionRequest` grows one optional field. Existing call sites compile unchanged. Demo code is unchanged.

The asymmetric-field invariant from ADR 0010 holds: provider-specific behaviour rides on the normalized request, documented per-adapter, silent no-op on the other shape where applicable.

`tryParseJSON` and `json-repair.ts` remain part of the public API — Anthropic prompt-only doesn't enforce, and OAI-compat hosts vary in how strictly they implement `response_format` (some local hosts treat it as a hint at best).
