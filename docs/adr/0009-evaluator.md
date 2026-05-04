# 0009 — Evaluator / quality gate on `orchestrate`

- **Status**: Accepted
- **Date**: 2026-05-04

## Context

`orchestrate` runs the router, picks a specialist, runs it, returns the answer. The first answer ships to the user verbatim. For demo flows that's fine; for production CRM/customer-facing agents it isn't. Common production failure modes a single-shot answer can't catch:

- Specialist hallucinates a fact in the response.
- Specialist forgot to call a tool the system prompt told it to.
- Specialist answered in the wrong format (e.g. plain text where JSON was required).
- Specialist gave a half-answer (acknowledged the request but didn't do it).

The classic fix is a second cheap-model pass: "is this a good answer? if not, why?" The orchestrator then either passes the answer through, or re-runs the specialist with the critique appended as a user message. This is the gap between "demo" and "product."

## Decision

Add an optional `evaluate` hook on `OrchestrateOpts` and a bounded retry loop on the buffered `orchestrate` path.

### Shape

```ts
type EvaluatorFn = (input: EvaluatorInput) => Promise<EvaluatorVerdict>;

interface EvaluatorInput {
  finalText: string;
  messages: Message[];   // full specialist transcript (user + assistant + any tool turns)
  attempt: number;       // 1-indexed; the attempt that just completed
  routedTo: string;
}

interface EvaluatorVerdict {
  ok: boolean;
  feedback?: string;     // injected on retry; default = generic reconsider prompt
  usage?: Usage;         // optional — caller may report LLM cost if their evaluate() called an LLM
}
```

`OrchestrateOpts` gains:

```ts
evaluate?: EvaluatorFn;
maxEvaluatorAttempts?: number;   // default 2 (= 1 retry); 1 = evaluate-only; ignored if evaluate undefined
```

`OrchestrateResult` gains:

```ts
evaluatorAttempts: number;       // 1 if no retry / no evaluator, N if retried
evaluatorUsage: Usage;           // sum of verdict.usage values (zero if evaluate undefined)
```

`usage` total = `routerUsage` + cumulative `specialistUsage` + `evaluatorUsage`. `specialistUsage` becomes the sum across attempts.

### Retry loop

After the specialist returns:

1. Call `evaluate({ finalText, messages, attempt, routedTo })`.
2. If `verdict.ok` or `attempt >= maxEvaluatorAttempts`: return.
3. Otherwise, append `{ role: "user", content: verdict.feedback ?? DEFAULT_FEEDBACK }` to the specialist's full transcript and re-run the specialist with the same role/tools. Increment attempt.

`DEFAULT_FEEDBACK = "Please reconsider your previous response and try again."`

At cap with `ok: false` the framework returns the last result without erroring. Same philosophy as `runAgent`'s `maxIterations`: bounded retries with a graceful exit. Caller can inspect `evaluatorAttempts === maxEvaluatorAttempts` if they want to detect "evaluator gave up."

### What's NOT supported

- **No built-in evaluator.** The framework provides the hook; the consumer writes the LLM call (or a heuristic). Same shape as `confirm`. A built-in would force a model choice and a prompt template — both belong in user space, where they can be tuned for the consumer's specialists and cost budget.
- **Streaming (`streamOrchestrate`) does NOT support `evaluate`.** By the time the evaluator could grade the answer, deltas have already reached the consumer; a retry would duplicate output. Setting `evaluate` on the streaming path throws early with a clear error message. Mirrors the existing "streamAgent does not support 'pending'" pattern.
- **Resume (`resumeOrchestrate`) does NOT support `evaluate`.** The user is responding to a specific suspended tool; re-evaluating the eventual answer would diverge from fresh-run behaviour and risk feedback loops where the evaluator critiques the user's own decision context. Resume always returns `evaluatorAttempts: 1`, `evaluatorUsage: zeroUsage()`.
- **No telemetry hook.** `evaluatorAttempts` + `evaluatorUsage` on the result are enough to wire metering on top.

### Channel layer

`ChatHandlerConfig` gains `evaluate?` and `maxEvaluatorAttempts?`, threaded straight through to `orchestrate` on the buffered handler. `createStreamingChatHandler`'s config explicitly omits these via the `Omit` clause — typed-out so consumers can't accidentally configure them on the streaming path.

## Why this shape

- **Pure callback, not a class.** Mirrors `confirm`. Easy to write inline, easy to mock in tests, easy to wrap with retry/timeout/logging without framework knowledge.
- **Feedback as a user message, not a system note.** The provider APIs disagree on how to inject mid-conversation guidance; user messages are the lowest-common-denominator that both Anthropic and OpenAI-compat hosts accept without translation. The specialist already knows how to read user messages; that's its job.
- **Total usage on the result, not per-attempt.** Consumers that meter cost want one number per request. They can still derive per-attempt from `evaluatorAttempts` if they care.
- **Cap default of 2 (1 retry).** Empirically: one retry catches most fix-it cases (typos, missing tool call). More retries risk runaway cost when the evaluator is itself wrong. Tunable per-call.

## Consequences

`OrchestrateResult` grows two fields. Existing consumers that destructure or spread it are unaffected (additive).

`streamOrchestrate` now throws on a previously-valid (silently-ignored) field combination. This is a deliberate fail-loud so consumers don't accidentally get a streaming flow that bypasses their evaluator.

Migration path for an OSS consumer wanting both streaming AND quality gating: do the buffered call for the first answer (with evaluator), then optionally re-stream once the answer is final. Out of scope for this ADR.
