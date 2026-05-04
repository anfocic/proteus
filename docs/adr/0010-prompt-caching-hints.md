# 0010 — Anthropic prompt caching hints

- **Status**: Accepted
- **Date**: 2026-05-04

## Context

Anthropic's prompt caching can cut input-token cost by ~75% on the cached prefix when the same system prompt + tool catalog are reused across calls. Production CRM-style consumers (intrebit being the canonical reference) hit the same specialist tens to hundreds of times an hour with a 1–4 KB role prompt and a stable tool list — exactly the workload caching is designed for.

The framework had no way to express "cache this prefix." The minimal hint Anthropic accepts is `cache_control: { type: "ephemeral" }` on a `system` block or a `tools[i]` entry. Adding it to the normalized request shape, where Anthropic honours it and OpenAI-compat ignores it, is the only Tier 1 item left on the roadmap.

This is the first deliberately-asymmetric provider field in the framework. Up to now, `LLMRequest` has been a normalized superset that both adapters can fully translate — every field meant something on both shapes. Caching breaks that contract. Either we accept asymmetry, or we punt the feature. We accept it; the cost is real and the alternative (per-adapter options bag) is worse for the common-case user.

## Decision

### Wire format

`CompletionRequest` gains:

```ts
cacheSystemPrompt?: boolean;
```

`ToolSchema` gains:

```ts
cacheBreakpoint?: boolean;
```

Both default to `undefined` (treated as false). `ToolDef extends ToolSchema`, so tool authors get `cacheBreakpoint` for free.

### Adapter behaviour

**Anthropic** (`src/llm/anthropic.ts`):

- If `cacheSystemPrompt && system`: emit
  ```json
  "system": [{ "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } }]
  ```
- Tools with `cacheBreakpoint: true`: emit `cache_control: { type: "ephemeral" }` alongside `name`/`description`/`input_schema`.
- Otherwise: existing wire shape unchanged (`system: <string>`, no `cache_control` on tools).

**OpenAI-compat** (`src/llm/openai-compat.ts`):

- Both fields are not read. Documented in code comment. Silent ignore.

### Specialist sugar

`Specialist` gains `cacheRole?: boolean`. When true, `runSpecialist`/`streamSpecialist`/`resumeSpecialist` set `cacheSystemPrompt: true` on the underlying `runAgent` call. This is the productive shorthand: specialists are exactly the case where the system prompt is static and worth caching, and consumers can flip one boolean per specialist instead of plumbing the lower-level field. Default false — opt-in; existing specialists' behaviour is unchanged.

### `runAgent` plumbing

`RunAgentInput.cacheSystemPrompt?: boolean` forwards to `complete`/`stream`. The `setup()` mapping from `ToolDef → ToolSchema` preserves `cacheBreakpoint` (the existing destructure was dropping it).

## Why this shape

- **Booleans, not block-array forms.** Roadmap entry called for `cacheBreakpoint?: boolean` — the simplest user-facing API. Keeping `system: string` (rather than widening to `string | { text, ... }`) means existing call sites compile unchanged. The structured form is an internal Anthropic detail; consumers don't need to think about it.
- **Top-level on `CompletionRequest`, not nested on system.** `system` stays a string. The boolean rides alongside as a sibling. Smaller blast radius on the type, and matches how `cacheBreakpoint` rides on `ToolSchema`.
- **`cacheRole` on Specialist, not always-on.** Static prompts are the common case but not universal. Some specialists are dynamically composed; caching a one-time prefix wastes the cache write. Opt-in is safer.
- **Silent ignore on OpenAI-compat.** The alternative — typed-out (compile error if you set an Anthropic field on a compat provider) — would require splitting `LLMRequest` per adapter, which defeats the abstraction. Runtime ignore is the conventional split: typed-on at the request level, no-op at the adapter level.

## What's NOT in scope

- **Message-level cache breakpoints.** Anthropic supports caching mid-conversation; deferred until a real consumer asks. Choosing which message to mark is non-trivial when tool transcripts shift positions across turns.
- **Cache hit metering.** Anthropic returns `cache_creation_input_tokens` and `cache_read_input_tokens` in `usage`. Adding typed fields to `Usage` touches every adapter, every test that asserts the shape, and every consumer that destructures. Deferred — the raw response is reachable via `CompletionResponse.raw` for now; we'll add typed fields together with cost mapping.
- **Breakpoint-count enforcement.** Anthropic caps at 4 breakpoints per request. We don't validate. If a consumer marks 10 tools, the typed `LLMBadRequestError` surfaces the API rejection. Documented behaviour, not framework policy.
- **OpenAI-shape host translation.** DeepSeek, Bedrock, and others have implicit caching that doesn't fit the explicit `cacheBreakpoint` model. We don't try to translate; the field is Anthropic-shaped and Anthropic-only.

## Consequences

`CompletionRequest` and `ToolSchema` grow optional fields. Existing call sites compile unchanged.

The "every field means something on both shapes" invariant in CLAUDE.md ("Adapters" section) is relaxed: provider-specific hints can ride on the normalized request as long as they're documented and silently no-op on the other shape. Future asymmetric fields should follow the same pattern (e.g. Anthropic-only thinking-block controls, when those ship).

Demo code is unchanged (caching not enabled by default).
