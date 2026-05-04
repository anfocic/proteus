# Intrebit gap-closing plan

> **Historical** — all gaps shipped via PR #12 (router multi-intent + chain + parallel + lenient JSON, ADRs 0012/0013) and PR #13 (tool concurrency cap + trimToBudget helper). Pending-collision dedup was dropped (suspend-mode makes it moot). Next-session handoff for the actual migration lives in `intrebit-migration.md`.

Reference doc for the wholesale swap effort: closing the deltas between
`intrebit/agents/core` and proteus so intrebit can consume proteus as a dep.
Pre-prod, no BWC concerns.

Branch: `feat/intrebit-gaps` off `feat/router-specialist`.
Strategy: 6 commits, single PR.

## Locked decisions

- BWC break in `Classification` is fine (multi-intent only, no helper for old shape).
- `trimToBudget` requires consumer-supplied tokenize callback (no default heuristic).
- Drop intrebit's `cacheStrategy: "none" | "system-and-tools" | "auto"` — proteus's single `cacheSystemPrompt` boolean stays.
- Streaming for chain/parallel modes deferred — `streamOrchestrate` throws early on those modes.
- Default knobs: chainContextChars=2000, parallel separator=`\n\n---\n\n`, preserveLast=1, pending collision flag=`existing: true`.

---

## Commit 1 — Router multi-intent + lenient JSON parse

### Why first
Every later orchestration commit depends on the new `Classification` shape.
Router must emit JSON before chain/parallel can dispatch.

### Files
- `src/agent/router.ts` — rewrite output parsing
- `src/agent/json-repair.ts` — NEW
- `src/agent/orchestrate.ts` — handle new Classification (single mode only here)
- `src/index.ts` — export `DispatchMode`, updated `Classification`
- `test/router.test.ts` — rewrite for new shape
- `test/json-repair.test.ts` — NEW
- `test/orchestrate.test.ts` — update assertions
- `test/usage.test.ts` — update `cls.intent` → `cls.intents[0].name`
- `docs/adr/0012-router-multi-intent.md` — NEW
- `docs/adr/README.md` — index update
- `CLAUDE.md` — orchestration section rewrite

### Type design

```ts
export type DispatchMode = "single" | "chain" | "parallel";

export interface Classification {
  intents: Intent[];          // length >= 1; falls back to first registered intent
  mode: DispatchMode;
  reasoning?: string;
  usage: Usage;
}

export interface ClassifyIntentOpts {
  llm: LLMProvider;
  model: string;
  intents: Intent[];
  message: string;
  history?: Message[];
  maxIntents?: number;        // default 3 — caps fan-out
}
```

### Router prompt shape
Asks for JSON only:
```json
{"intents": ["name1", "name2"], "mode": "single|chain|parallel", "reasoning": "..."}
```
Rules embedded: non-empty array, names from registered set, single for one-intent
requests, chain for dependent steps, parallel for unrelated tasks, max N intents.

### Lenient parser (`src/agent/json-repair.ts`)
```ts
export function tryParseJSON(text: string): { ok: true; value: unknown } | { ok: false };
```
Strategy:
1. Strict `JSON.parse` — return on success.
2. Strip markdown fences (```json ... ```), extract first `{` to last `}`.
3. Walk char-by-char tracking string + escape state; count `{`/`[` depth; append closers.
4. Drop trailing commas before `}` or `]`.
5. Re-attempt parse.

~60 lines, no deps.

### Router parse flow
1. Build system prompt + user message.
2. `llm.complete` with temp 0.
3. Extract text from response (text block, fallback to reasoning).
4. `tryParseJSON`.
5. Validate: `intents` non-empty string array; `mode` in enum.
6. Map names to Intent objects; drop unknowns; if all unknown, fallback to `intents[0]` of registered.
7. Truncate to `maxIntents`.
8. Default mode to `"single"` when missing or invalid.
9. Return `{ intents, mode, reasoning, usage }`.

### Orchestrate behavior in commit 1
```ts
switch (cls.mode) {
  case "single":   /* existing behavior, using cls.intents[0] */
  case "chain":    throw new Error("chain mode not yet implemented");
  case "parallel": throw new Error("parallel mode not yet implemented");
}
```
Commits 2/3 replace the throws. Each commit stays independently green.

### Tests
**`test/json-repair.test.ts`** (~10):
- Strict valid JSON → ok
- Trailing comma → ok
- Unclosed string → ok with closing quote added
- Unclosed brace / bracket → ok
- Markdown fence wrapper → strips
- Prose surrounding JSON → extracts substring
- Truly broken (no `{`) → fail
- Empty string → fail
- String containing `}` (escape handling) → ok
- `\"` does not terminate string

**`test/router.test.ts`** (rewrite, ~8):
- Single intent JSON → `intents=[x]`, `mode=single`
- Multi-intent + `mode=parallel` → both intents, mode preserved
- `mode=chain` ordering preserved
- Reasoning falls back to reasoning block
- Truncated JSON (lenient parse engages) → valid Classification
- Garbage response → fallback to first registered, `mode=single`
- Unknown intent name → dropped; all unknown → fallback
- `maxIntents=2` + 5 returned → truncated
- Usage propagates

**`test/orchestrate.test.ts` updates**:
- All assertions against `cls.intents[0]`
- New: `mode=parallel` returned by router → orchestrate throws "not implemented" (replaced in commit 3)

**`test/usage.test.ts` updates**:
- `cls.intent` → `cls.intents[0].name`
- Add `cls.mode === "single"` assertion

### ADR 0012 (Router multi-intent)
Sections: Context (intrebit emits `{intents, mode}`; local models truncate
JSON), Decision (structured output, lenient parser, BWC break, modes single
default + chain/parallel land in 0013), Why JSON (one call vs many; mode +
intents are correlated), Why lenient parse (local models truncate; strict
parse blocks self-hosted), Consequences.

---

## Commit 2 — Chain orchestration

### Files
- `src/agent/orchestrate.ts` — implement chain branch
- `src/agent/chain.ts` — context-formatter helper
- `test/chain.test.ts` — NEW
- `docs/adr/0013-chain-and-parallel-orchestration.md` — NEW
- `CLAUDE.md` — orchestration section

### Behavior
When `cls.mode === "chain"`: run intents in order. Each step receives:
- Original user message
- Prior step's `finalText`, truncated to `chainContextChars` (default 2000),
  prefixed with prior specialist name

Format function configurable:
```ts
type ChainContextFormatter = (steps: ChainStep[], original: string) => Message[];
interface ChainStep { specialist: string; finalText: string; }
```

### Result shape
```ts
interface OrchestrateResult {
  // existing fields
  steps?: Array<{ specialist: string; result: RunAgentResult }>;
}
```
Single mode → `steps` undefined (no overhead). Chain mode → populated.

### Failure
Error in step N aborts chain, surfaces with `steps[0..N-1]` populated on the
thrown error (extend error type or attach as `cause`-style metadata — TBD
during implementation).

### Streaming
`streamOrchestrate({ mode === "chain" })` throws early. Documented.

### Tests (`test/chain.test.ts`)
- 2-step chain: prior text appears in second specialist's input messages
- Truncation to `chainContextChars`
- Custom formatter overrides default
- Step 2 throws → error propagates, `steps[0]` preserved
- Usage = sum across all steps + router

### ADR 0013 (Chain + parallel orchestration)
Combined ADR for both modes since they share `steps[]` result shape and the
"streaming not supported on multi-mode" decision.

---

## Commit 3 — Parallel orchestration

### Files
- `src/agent/orchestrate.ts` — implement parallel branch
- `test/parallel.test.ts` — NEW
- ADR 0013 already covers (extend with parallel-specific section in same file)
- `CLAUDE.md` — orchestration section

### Behavior
`cls.mode === "parallel"`: `Promise.allSettled` over intents → all run
concurrently against the **original** user message (no carry-over).

Aggregator:
```ts
type ParallelAggregator = (results: ParallelStepResult[]) => string;
```
Default: concat fulfilled `finalText`s with `\n\n---\n\n`. Failures included
as `[error from <specialist>: <message>]` unless aggregator omits them.

### Result shape
```ts
type ParallelStepResult =
  | { specialist: string; status: "fulfilled"; result: RunAgentResult }
  | { specialist: string; status: "rejected"; error: Error };
```
Reuses `OrchestrateResult.steps` (typed as union when parallel mode used).

### Streaming
Same as chain — throws early.

### All-fail
Returns `OrchestrateResult` with `finalText` from default aggregator (lists
errors). No throw — caller inspects `steps`.

### Tests (`test/parallel.test.ts`)
- 2-way fanout, both succeed, aggregated text
- One rejects → other still in steps
- All reject → aggregator renders, no throw
- Custom aggregator
- Usage = sum across fulfilled steps only

---

## Commit 4 — Tool concurrency cap

### Files
- `src/agent/run.ts` — thread `toolConcurrency` through dispatch
- `src/agent/concurrency.ts` — `mapLimit` helper
- `src/agent/specialist.ts`, `src/agent/orchestrate.ts` — opts threading
- `test/concurrency.test.ts` — NEW
- `CLAUDE.md` — tool loop section (no ADR; small additive knob)

### API
```ts
interface RunAgentInput {
  // existing
  toolConcurrency?: number;   // default unbounded
}
```
Threaded through `RunSpecialistOpts`, `OrchestrateOpts`, `streamAgent`,
`resumeAgent`.

### Implementation
`mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]>`
preserves input order. Used in `dispatchTools` chokepoint.

Confirmation gate stays serialized (already is). Concurrency cap applies only
to handler execution after confirms resolve.

### Tests (`test/concurrency.test.ts`)
- 5 tools, cap=2, instrumented handler tracks concurrent count → asserts max 2
- cap=undefined → all parallel (existing)
- Order of `tool_result` messages matches order of `tool_use` blocks (regression)

---

## Commit 5 — Session token budget helper

### Files
- `src/agent/budget.ts` — NEW
- `src/index.ts` — export
- `test/budget.test.ts` — NEW
- `CLAUDE.md` — new "Session budget" subsection

### API
```ts
type Tokenize = (text: string) => number;

function trimToBudget(opts: {
  messages: Message[];
  maxTokens: number;
  tokenize: Tokenize;        // required, no default
  preserveLast?: number;      // default 1
}): Message[];
```

### Counting
- `string` content → `tokenize(content)`
- `ContentBlock[]` content → sum over text blocks (text), reasoning blocks (text), tool_use blocks (`JSON.stringify(input)`)
- `tool_result` messages → `tokenize(content)`

### Behavior
Drops oldest first. Always preserves last `preserveLast` messages regardless
of budget. Returns new array (does not mutate).

### Why required tokenize
Tokenizers are model-specific. Shipping a default heuristic silently misleads.
Force consumer to pass `(s) => Math.ceil(s.length / 4)` explicitly if they
want the rough approximation.

### Tests (`test/budget.test.ts`)
- Trims oldest until under budget
- Preserves last N
- Exact-fit no trim
- Under-budget no-op
- Empty messages → empty
- Tool messages counted by content length
- ContentBlock arrays count text + reasoning + stringified tool_use

No ADR — pure helper.

---

## Commit 6 — Pending-action collision dedup

### Files
- `src/channel/pending.ts` — `set` returns `SetResult`
- `src/channel/http.ts` — propagate existing flag
- `test/http.test.ts` — extend
- `docs/adr/0014-pending-collision-dedup.md` — NEW (extends 0008)
- `docs/adr/README.md` — index update
- `CLAUDE.md` — channel section

### Interface change
```ts
type SetResult =
  | { kind: "stored" }
  | { kind: "exists"; existing: PendingRecord };

interface PendingStore {
  get(sessionId: string): Promise<PendingRecord | undefined>;
  set(sessionId: string, record: PendingRecord): Promise<SetResult>;  // was Promise<void>
  clear(sessionId: string): Promise<void>;
}
```
First-write-wins. In-memory impl: check `get` then write only if absent.

### ChatHandler propagation
When `set` returns `"exists"`:
```ts
{ kind: "pending", toolUseId, name, summary, routedTo, existing: true }
```
Default messaging unchanged otherwise.

### Why
Matches intrebit's case: one specialist turn emits multiple write tools — all
hit `set`, only first persists; rest see "already_pending".

### Tests
- Two `set`s same session → second returns `exists` w/ first record
- ChatHandler returns existing-flagged pending on collision
- Resume still works, clears regardless of `existing` state

---

## Cross-cutting cleanup (folded into commit 6)

- `CLAUDE.md`:
  - Orchestration section: multi-intent + chain + parallel + streaming-not-supported caveat
  - Tool loop: `toolConcurrency` knob
  - New "Session budget" subsection
  - Channel section: pending collision behavior
  - Drop "Multi-specialist chain/parallel orchestration modes" from "What does NOT belong"
- `docs/adr/README.md` index: add 0012, 0013, 0014

## Test count target
~30 new tests across 5 new test files + extensions to `router.test.ts`,
`orchestrate.test.ts`, `usage.test.ts`, `http.test.ts`. Land at ~200 total.

## Verification per commit
`npm run typecheck` + `npm test` clean. No commit lands red.
