# 0011 — Cache-token metering on `Usage`

- **Status**: Accepted
- **Date**: 2026-05-04

## Context

ADR 0010 added Anthropic prompt-caching hints (`cacheSystemPrompt`, `cacheBreakpoint`) but explicitly deferred metering: the response-side fields `cache_creation_input_tokens` and `cache_read_input_tokens` were reachable only via `CompletionResponse.raw`. Any consumer that wanted to measure cache effectiveness — hit rate, cost savings, or per-tier billing — had to cast `raw` and parse provider-shaped JSON, defeating the normalized-response abstraction one ADR earlier.

The two providers report cached input differently:

- **Anthropic**: `usage.cache_creation_input_tokens` (tokens written into cache, billed at ~1.25× base) and `usage.cache_read_input_tokens` (tokens served from cache, billed at ~0.1× base). Distinct pricing tiers — the difference matters for cost reporting.
- **OpenAI-compat**: `usage.prompt_tokens_details.cached_tokens`. No write/read distinction — caching is implicit and only the read count is exposed. Many compat hosts mirror this; others omit the field entirely.

## Decision

`Usage` gains two optional fields:

```ts
interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;  // anthropic-only
  cacheReadInputTokens?: number;       // both providers
}
```

Both are `?: number` rather than defaulting to 0 — the absence of a field carries information ("this host does not report it"), which a consumer building per-provider cost tables needs to distinguish from "host reported zero cached tokens this turn." Consumers that don't care can ignore the fields entirely; the existing `inputTokens` / `outputTokens` shape is unchanged.

### Adapter mapping

- **Anthropic** (`complete` + stream `message_start`): copy both fields when present, leave undefined otherwise.
- **OpenAI-compat** (`complete` + stream chunks): copy `prompt_tokens_details.cached_tokens` to `cacheReadInputTokens`. Never sets `cacheCreationInputTokens` — there is no equivalent concept.

### `addUsage` semantics

Undefined-aware sum: `undefined + undefined → undefined`; otherwise treat undefined as 0 and sum. Keeps OpenAI-compat aggregates clean (no spurious `cacheCreationInputTokens: 0` after a multi-turn run) while still producing a usable total when at least one operand reports the field.

`runAgent`, `orchestrate`, and the evaluator/router/specialist usage breakdowns already aggregate via `addUsage` — propagation is automatic, no per-callsite changes needed.

## Why this shape

- **Two fields, not one.** Anthropic's creation/read split maps to a real pricing difference. Collapsing to a single `cachedInputTokens` would lose information that consumers will immediately need for cost tables. The cost of two fields vs one is one extra optional property — cheap.
- **Optional, not zero-default.** "Field absent" and "field present and zero" mean different things across providers. An OpenAI-compat host with no cache reporting (Ollama, some self-hosted gateways) should look different from a host that reports `cached_tokens: 0` for an uncached call.
- **Adapter-side parsing, not request-side opt-in.** Unlike ADR 0010's hints (which are user intent and must opt in), metering is observation. The framework reports what the provider sends; the consumer chooses whether to read the field.
- **Aggregation via existing `addUsage`.** No new helper, no new code path. The runAgent loop, orchestrate breakdowns, and evaluator/router/specialist sums all flow through `addUsage` — extending its merge logic was the only change needed for end-to-end propagation.

## Consequences

`Usage` grows two optional fields. Existing consumers that destructure `{ inputTokens, outputTokens }` are unaffected; consumers that read the full object see new optional properties.

The "asymmetric provider features" pattern from ADR 0010 holds: Anthropic-only fields surface as optional and silently undefined on OpenAI-compat. The metering side is *more* symmetric than the hint side — `cacheReadInputTokens` is genuinely cross-provider when the host supports it.

Cost mapping (per-model rate tables) remains user-space, as called out in CLAUDE.md. The framework's job ends at exposing the counts.

The CLAUDE.md caveat under "Caching hints" — "Cache hit metering ... is not yet typed on `Usage` — read `CompletionResponse.raw` for now" — is removed.
