# Roadmap

What's shipped, what's queued, what's deliberately not. Phase 1 (provider abstraction + adapters), Phase 2 (router → specialist → orchestrate + tests), and the streaming layer are in. Phase 3 has confirmation gate, typed `LLMError` hierarchy, the `withRetry` wrapper, usage aggregation on agent/orchestrate results, HTTP suspend/resume for the confirm gate, per-tool `timeoutMs` + `maxResultBytes` defensive caps, the evaluator/quality-gate hook on `orchestrate`, and Anthropic prompt-caching hints (`cacheSystemPrompt` + `ToolSchema.cacheBreakpoint` + `Specialist.cacheRole`) in. The list below is the work that turns this PoC into something a real consumer (intrebit, third-party agents) can build on top of.

Tiers reflect impact, not difficulty. Pick by goal: tier 1 if the goal is "intrebit consumes proteus as a dep", tier 4 if the goal is "OSS portfolio that gets stars".

## Tier 1 — Real consumers hit these immediately

_All Tier 1 items shipped._

## Tier 2 — Bites once you have N specialists or real users

| Item | Sketch | Notes |
|---|---|---|
| **Multi-specialist chain / parallel** | `orchestrate` modes: `chain` (specialist A → B uses A's output), `parallel` (run both, merge). | intrebit already does this. Port aggressively-simplified versions when needed. |
| **Telegram message-edit streaming** | Edit-throttled streaming (`editMessageText` under the 1 msg/sec rate limit). Buffer deltas for ~500ms, edit. | Ships on top of `streamAgent`. ADR 0004/0005 bracket the design space. |

## Tier 3 — Infrastructure, not framework

| Item | Sketch | Notes |
|---|---|---|
| **Real `SessionStore` backends** | `pgSessionStore({ pool })`, `redisSessionStore({ client })`. Same two-method interface; consumer brings the dep. | `inMemoryStore` already proves the contract. |
| **Observability hooks** | `RunAgentInput.hooks?: { onLLMCall?, onToolDispatch?, onConfirmRequest?, onError? }`. Threaded through `runSpecialist`/`orchestrate`. | A single hooks interface beats wrapping individual functions. Datadog/Sentry/OTEL trivial after this. |
| **Migration helpers** | `inMemoryStore` → `pgSessionStore` swap in one line. Maybe a `composeStores` for read-through caching. | Smooths the PoC → prod transition. |

## Tier 4 — Distribution, not code

| Item | Sketch | Notes |
|---|---|---|
| **README worth a stranger reading** | Elevator pitch + 30-line snippet + screenshot/gif of triage demo. | Today's README is ADR-grade; needs a marketing pass. |
| **Published to npm** with `dist/` + types | Build script (`tsup`/`tsc -d`), `exports` field in `package.json`, npm publish action. Real consumers `npm install proteus`. | Gates intrebit consumption; today they'd vendor source. |
| **Versioned API + `CHANGELOG.md`** | SemVer, changelog keyed off merged PR titles. | Once intrebit consumes it, breaking changes need to be intentional. |
| **CI** (typecheck + tests on every PR) | GitHub Actions matrix: Node 20/22, both providers (compat against a free host like Groq, anthropic against a smoke key in secrets). | Catches regressions before they hit `feat/router-specialist`. |

## Deliberately NOT on the roadmap

- **More LLM adapters.** Two-shape coverage is the point. Adding Gemini/Cohere is variant noise unless they're a third structurally distinct shape.
- **A "framework" abstraction layer above `runAgent`.** The whole pitch is the abstraction is legible. Don't bury it.
- **Confirmation queues / write-tool taxonomies in proteus.** The current opt-in design is right for a generic framework; CRM-specific machinery belongs in the consumer.
- **Built-in formatGuide.** Tool authors can include format hints in their tool descriptions; framework-level adds noise.

## Recommended next-session pick

If the goal is *intrebit consumes proteus*: **auto-retry → usage tracking → caching hints**. That trio plus what's shipped covers ~95% of what production CRM agent code needs today.

If the goal is *OSS portfolio that gets stars*: **README + npm publish + CI**. Tier 4 is what makes strangers find and trust it.
