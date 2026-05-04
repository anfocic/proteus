# 0013 — Chain and parallel orchestration modes

- **Status**: Accepted
- **Date**: 2026-05-04

## Context

ADR 0012 reshaped the router output to `{ intents, mode, reasoning, usage }`
where `mode` is one of `single | chain | parallel`. Chain and parallel
branches initially threw "not yet implemented." This ADR specifies and
lands them.

The motivating workloads come from intrebit's CRM operator:
- **Chain**: "find John, then show his deals" — the second specialist
  needs the first's lookup result to filter correctly.
- **Parallel**: "show my pipeline and today's tasks" — two unrelated
  specialists, fan out and concatenate.

## Decision (chain — this commit)

When `cls.mode === "chain"`:

1. Iterate `cls.intents` in order.
2. For each step, build the user message via a formatter:
   - First step: original `opts.message` unchanged.
   - Subsequent steps: `${original}\n\n<previous_step_output>${escaped + truncated}</previous_step_output>`
3. Run the matched specialist via `runSpecialist` with
   `[...history, { role: "user", content: augmented }]`. Tool transcripts
   from prior steps are NOT carried (matches the "history caveat" in
   CLAUDE.md — different specialist's tool ids would collide).
4. Aggregate usage across all steps.
5. `OrchestrateResult.steps?: ChainStep[]` is populated; `routedTo` is the
   last specialist's name; `finalText` is the last specialist's `finalText`.

### Knobs

- `chainContextChars?: number` (default 2000 — intrebit's `MAX_CHAIN_CONTEXT_LENGTH`).
- `chainContextFormatter?: ChainContextFormatter` for full override of the
  augmented user-message shape.

### Failure semantics

A step throwing aborts the chain and surfaces a `ChainDispatchError`
carrying `steps: ChainStep[]` (completed steps) and `failedAt: string`
(specialist name). The original error is chained as `cause`. Caller can
recover from the partial result if desired.

The unknown-specialist guard (router-validated intents shouldn't normally
hit this, but defends against custom routers) throws the same error type
without a `cause`.

### Evaluator

`evaluate` set with `mode: "chain"` throws early. Chain + evaluator
semantics (which step does the verdict cover? does retry replay the whole
chain or just the last step?) are deferred until a real consumer needs
them. Single mode keeps full evaluator support.

### Streaming

`streamOrchestrate` continues to throw on chain mode. Streaming a chain
would need to interleave step boundaries with deltas, plus decide how
multi-specialist token usage and confirms compose — out of scope for the
intrebit migration.

## Decision (parallel — next commit)

Parallel-mode dispatch lands as a sibling commit: `Promise.allSettled`
fan-out against the original message, fulfilled `finalText`s joined with
`"\n\n---\n\n"`, rejections preserved in `steps[]` but dropped from the
joined output. This ADR will be amended with the parallel-specific
sections when that commit lands.

## Why this shape

- **Verbatim port from intrebit** (`operator/src/orchestrator.ts:49-65`).
  The `<previous_step_output>` XML wrapping is exactly what production
  uses; deviating loses behaviour the operator already validated.
- **Fresh history per step, not running history.** Carrying tool
  transcripts across specialists would corrupt the next specialist's
  schema — the existing history caveat in CLAUDE.md spells out why. Chain
  steps re-derive context from the prior step's `finalText` only.
- **Last-step `routedTo`.** A chain returns one final text and one
  `routedTo` for downstream display. Joining names ("a → b") is consumer
  policy — they have `steps` to format however they want.
- **Bounded context (default 2000 chars).** A long lookup result blows
  the budget for the next step's prompt. 2000 is intrebit's number; opt
  out via custom formatter or larger `chainContextChars`.

## Consequences

`OrchestrateResult.steps` joins `routerReasoning?` and the
`evaluatorAttempts/evaluatorUsage` fields as additive on the existing
result type. Single-mode callers see no behavioural change.

`ChainDispatchError`, `defaultChainFormatter`, `escapeXmlAngles`, and
`ChainStep` are exported. The XML escape helper is reused by the
formatter; consumers wrapping CRM data in similar XML tags can use it
directly.
