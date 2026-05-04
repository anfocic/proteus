# 0012 — Router multi-intent + lenient JSON parse

- **Status**: Accepted
- **Date**: 2026-05-04

## Context

Proteus's router today returns a single intent name as plain text and the
orchestrator runs one specialist. Real-world consumers (intrebit being the
canonical reference) need to handle compound requests: "find John and show
his deals" wants two specialists chained; "show pipeline and today's tasks"
wants two specialists in parallel.

Closing this gap is the largest architectural delta blocking the intrebit
swap. Every CRM compound request flows through it.

A second motivation: local model hosts (lmstudio, some Ollama setups) often
emit truncated or malformed JSON when asked for structured output. A strict
`JSON.parse` blocks self-hosted setups entirely. Intrebit ships a small
lenient parser that closes unclosed brackets/strings/commas — porting it
removes a real production blocker.

## Decision

### Wire shape (BWC break)

`Classification` becomes:

```ts
type DispatchMode = "single" | "chain" | "parallel";

interface Classification {
  intents: Intent[];           // length >= 1; falls back to first registered
  mode: DispatchMode;
  reasoning?: string;
  usage: Usage;
}

interface ClassifyOpts {
  llm: LLMProvider;
  model: string;
  intents: Intent[];
  message: string;
  history?: Message[];
  maxIntents?: number;          // default 3 — caps fan-out
}
```

The previous `intent: string` + `raw: string` + `fallback?: string` shape is
replaced. Pre-prod, no consumers in production, BWC break is acceptable.

`OrchestrateResult.routerRaw` becomes `routerReasoning?` and the streaming
event mirrors the rename.

### Router prompt

Structured JSON-only output:

```json
{"intents": ["name1"], "mode": "single", "reasoning": "brief"}
```

System prompt embeds the registered intent list with descriptions plus
short rules: chain when one intent depends on another, parallel when
independent, single otherwise. `maxTokens: 320`, `temperature: 0`.

### Lenient parser (`src/agent/json-repair.ts`)

`tryParseJSON(text) → { ok: true, value } | { ok: false }` with this order:

1. Strip markdown fences (` ```json ... ``` `, ` ``` ... ``` `).
2. Strict `JSON.parse` — return on success.
3. Trim trailing comma.
4. Walk char-by-char tracking string state and a stack of expected closers
   (`{` pushes `}`, `[` pushes `]`, matching closer pops).
5. Append `"` if string is unclosed; pop the stack in reverse, appending
   each closer.
6. Re-attempt parse. On failure → `{ ok: false }`.

The stack-based approach (vs intrebit's two depth counters) correctly
handles interleaved nesting like `{"xs": [1, {"a": "y` — produces
`{"xs": [1, {"a": "y"}]}`, not the bracket-order-blind `{"xs": [1, {"a": "y"]}}`.

### Orchestrate dispatch

```ts
switch (cls.mode) {
  case "single":   /* existing behavior, using cls.intents[0] */
  case "chain":    throw new Error("orchestrate: chain mode not yet implemented");
  case "parallel": throw new Error("orchestrate: parallel mode not yet implemented");
}
```

The chain and parallel branches land in the immediately-following commits
(see ADR 0013). Each commit stays independently green; the throws are
replaced cleanly when those commits land.

### Fallback chain

- Parse fails (after lenient repair) → `{ intents: [registered[0]], mode: "single", reasoning: "router parse failed" }`
- Parse OK but no `intents` array / non-string entries → same fallback with reason "router returned no known intents"
- Mix of known + unknown names → keep only known (preserves order, dedupes)
- Unknown `mode` value → coerce to `"single"`

## Why this shape

- **JSON over multiple LLM calls.** Mode and intents are correlated
  decisions — the router needs both to make the call coherent. One prompt
  is cheaper and more accurate than chaining.
- **Lenient parser is critical, not nice-to-have.** Without it, a single
  truncated response from a local model produces an unhandled exception.
  The 30-line repair port keeps the framework usable across the full
  provider matrix proteus already supports.
- **BWC break is cheap pre-prod.** A `Classification.intents[0].name` shim
  would have cost type complexity for zero real callers. Drop it.
- **Stack vs depth counters.** Intrebit's algorithm uses two counters
  (`openCurly`, `openSquare`) and appends `]]` then `}}` in fixed order.
  This is buggy for interleaved nesting. The stack variant is one extra
  line and correct.

## Consequences

`OrchestrateOpts.maxEvaluatorAttempts` and the evaluator gate continue to
work in single mode unchanged. Chain/parallel modes lose evaluator support
by definition (parallel: which specialist gets the retry?; chain: feedback
loop targets last specialist — implemented in ADR 0013).

`streamOrchestrate` retains today's behavior in single mode and throws
early on chain/parallel — streaming multi-mode dispatch is a separate
discussion deferred until a real consumer asks.

The lenient parser is exported (`tryParseJSON`, `stripJsonFences`) for any
consumer that wants the same robustness against local-model output.
