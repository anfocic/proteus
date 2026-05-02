# NEXT — Phase 2: Router + Specialist + Tests

This is a self-contained plan a future Claude session (or me, in your IDE terminal) can pick up and execute. Phase 1 (PoC) is done: `LLMProvider` interface, two adapters, basic `runAgent` loop, validated end-to-end against GLM via OpenCode Go.

## Goal of Phase 2

Port the **router → specialist → tool** pattern from `~/Desktop/intrebit/agents/operator/src/claude/` so Proteus is more than a thin wrapper around a chat completion. This is the actual portfolio differentiator — the provider abstraction is table stakes; the agent orchestration architecture is the IP.

Test framework: `node:test` (zero runtime *and* dev deps for testing — preserves the "almost nothing in package.json" pitch).

## Architecture being added

```
runAgent (Phase 1 — exists)
    ↑ consumed by ↓

Specialist           (a named agent with role, tools, services)
    ↑
Router               (classifies user intent → specialist name)
    ↑
Orchestrator         (router + specialist registry + dispatch)
    ↑
Channel adapter      (LATER — Phase 3, not this plan)
```

## Hard constraint to preserve

`src/agent/run.ts` and the new orchestration files **only** import from `src/llm/types.ts` and `src/llm/provider.ts`. Never directly from `anthropic.ts` or `openai-compat.ts`. Provider construction stays in user code.

## Files to add

```
src/agent/
├── run.ts                 (exists — needs ToolContext genericization, see §1)
├── context.ts             (NEW — ToolContext<TServices> generic)
├── specialist.ts          (NEW — createSpecialist factory + Specialist type)
├── router.ts              (NEW — classifyIntent function)
└── orchestrate.ts         (NEW — top-level dispatch combining router + specialists)

test/
├── run.test.ts            (NEW — mock provider, tool loop, parallel calls, max iters)
├── router.test.ts         (NEW — intent classification with mock provider)
├── specialist.test.ts     (NEW — specialist tool dispatch with services)
├── orchestrate.test.ts    (NEW — end-to-end with mock router + specialists)
└── adapters.test.ts       (NEW — request/response translation, no network)

demo/
└── triage.ts              (NEW — demonstrates orchestrator: weather vs math intents)
```

Do **not** modify `src/llm/*` in this phase. Adapter changes are out of scope.

## §1 — Genericize `ToolContext` first (refactor `run.ts`)

Current `run.ts` has tool handlers as `(input: unknown) => Promise<string>`. New shape threads a generic context.

### `src/agent/context.ts`

```ts
export interface ToolContext<TServices = Record<string, unknown>> {
  services: TServices;
  formatGuide?: string;
}
```

That's the whole file. Don't add anything else — keep it minimal. `services` is an opaque dict the consumer fills with whatever (DB clients, API keys, helpers). Proteus never inspects it.

### Update `src/agent/run.ts`

Change `ToolDef` to:

```ts
export interface ToolDef<TInput = unknown, TServices = Record<string, unknown>> extends ToolSchema {
  handler: (input: TInput, ctx: ToolContext<TServices>) => Promise<string> | string;
}
```

Add a `services` field (and optional `formatGuide`) to `RunAgentInput`:

```ts
export interface RunAgentInput<TServices = Record<string, unknown>> {
  llm: LLMProvider;
  model: string;
  system?: string;
  tools: ToolDef<unknown, TServices>[];
  messages: Message[];
  services?: TServices;
  formatGuide?: string;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
}
```

In the tool dispatch loop, build a `ctx: ToolContext<TServices>` from `input.services` (default to `{}` cast as `TServices`) and `input.formatGuide`, then call `handler(parsedInput, ctx)`.

**Update existing demos** so they still compile: `demo/weather.ts` and `demo/multi-tool.ts` need to pass `services: {}` (or omit, defaulting). Tool handlers ignore `ctx`.

Verify: `npx tsc --noEmit` clean, `PROVIDER=compat npm run demo` still works.

## §2 — `Specialist`

### `src/agent/specialist.ts`

```ts
import type { LLMProvider } from "../llm/provider.ts";
import type { Message } from "../llm/types.ts";
import type { ToolContext } from "./context.ts";
import type { ToolDef, RunAgentResult } from "./run.ts";
import { runAgent } from "./run.ts";

export interface Specialist<TServices = Record<string, unknown>> {
  name: string;
  description: string;            // for the router — what this specialist handles
  role: string;                   // system prompt body (no formatting boilerplate)
  tools: ToolDef<unknown, TServices>[];
  model?: string;                 // optional override; orchestrator passes default
  toolChoice?: { type: "auto" } | { type: "any" };
}

export function createSpecialist<TServices>(config: Specialist<TServices>): Specialist<TServices> {
  return config;  // identity for now — gives a stable factory site for future hooks
}

export interface RunSpecialistOpts<TServices> {
  llm: LLMProvider;
  specialist: Specialist<TServices>;
  defaultModel: string;
  messages: Message[];
  services: TServices;
  formatGuide?: string;
  maxIterations?: number;
}

export async function runSpecialist<TServices>(
  opts: RunSpecialistOpts<TServices>,
): Promise<RunAgentResult> {
  return runAgent({
    llm: opts.llm,
    model: opts.specialist.model ?? opts.defaultModel,
    system: opts.formatGuide
      ? `${opts.specialist.role}\n\n## Format\n${opts.formatGuide}`
      : opts.specialist.role,
    tools: opts.specialist.tools,
    messages: opts.messages,
    services: opts.services,
    formatGuide: opts.formatGuide,
    maxIterations: opts.maxIterations,
  });
}
```

Reference: `intrebit/agents/operator/src/claude/specialists/base.ts` (much heavier — production has confirmation gates, ops alerts, evaluators; we ship none of that yet).

## §3 — `Router`

### `src/agent/router.ts`

```ts
import type { LLMProvider } from "../llm/provider.ts";
import type { Message } from "../llm/types.ts";

export interface Intent {
  name: string;                   // must match a specialist.name
  description: string;            // help the model classify
}

export interface ClassifyOpts {
  llm: LLMProvider;
  model: string;
  intents: Intent[];
  message: string;
  history?: Message[];            // last N user/assistant pairs for context (caller windows)
  systemPrefix?: string;          // optional added context (e.g. "You are routing for an HR agent")
  fallback?: string;              // intent name when classifier is unsure (default: first)
}

export interface Classification {
  intent: string;
  raw: string;                    // raw model output, for debugging
}

export async function classifyIntent(opts: ClassifyOpts): Promise<Classification>;
```

Implementation outline:

1. Build a system prompt: `systemPrefix` + a numbered list of intents (`name: description`) + an instruction "Reply with ONLY the intent name, nothing else."
2. Build messages = `history ?? []` + `{ role: "user", content: opts.message }`.
3. `llm.complete({ model, system, messages, maxTokens: 32, temperature: 0 })` — no tools, no tool_choice.
4. Extract text from response, lowercase + trim.
5. If text matches a known intent name (substring or exact, your call — start with exact-match-after-trim), return it.
6. Else return `fallback ?? intents[0].name`.

Reference: `intrebit/agents/operator/src/claude/router.ts:169` — same shape, just with hardcoded CRM intents. Generic-ize the intent list, that's the whole change.

**Cost note**: routing should use a cheap model (`qwen3.5-plus`, `deepseek-v4-flash`). The orchestrator API lets the caller pass separate `routerModel` and `specialistModel`.

## §4 — `Orchestrator`

### `src/agent/orchestrate.ts`

```ts
import type { LLMProvider } from "../llm/provider.ts";
import type { Message } from "../llm/types.ts";
import type { Specialist, RunSpecialistOpts } from "./specialist.ts";
import { runSpecialist } from "./specialist.ts";
import { classifyIntent, type Intent } from "./router.ts";
import type { RunAgentResult } from "./run.ts";

export interface OrchestrateOpts<TServices> {
  llm: LLMProvider;
  routerModel: string;
  specialistModel: string;
  specialists: Specialist<TServices>[];
  services: TServices;
  message: string;
  history?: Message[];
  formatGuide?: string;
  routerSystemPrefix?: string;
  fallbackSpecialist?: string;    // name; defaults to specialists[0].name
}

export interface OrchestrateResult extends RunAgentResult {
  routedTo: string;               // which specialist handled it
  routerRaw: string;
}

export async function orchestrate<TServices>(
  opts: OrchestrateOpts<TServices>,
): Promise<OrchestrateResult>;
```

Implementation:

1. Build `intents: Intent[]` from `specialists.map(s => ({ name: s.name, description: s.description }))`.
2. `classifyIntent({ llm, model: routerModel, intents, message, history, systemPrefix: routerSystemPrefix, fallback: fallbackSpecialist })`.
3. Look up the chosen specialist by name. If not found, use `specialists[0]` (defensive, but should be unreachable given fallback logic).
4. `runSpecialist({ llm, specialist, defaultModel: specialistModel, messages: [...history, { role: "user", content: message }], services, formatGuide })`.
5. Return `{ ...result, routedTo: specialist.name, routerRaw: classification.raw }`.

That's the orchestration. ~50 lines.

## §5 — `demo/triage.ts`

A demo that proves the architecture works. Two specialists, one router, both reachable.

```ts
// pseudo-shape — write it from scratch following demo/weather.ts pattern
const weatherSpecialist = createSpecialist({
  name: "weather",
  description: "Questions about weather, climate, temperature, or atmospheric conditions",
  role: "You answer weather questions using the get_weather tool.",
  tools: [/* get_weather tool */],
});

const mathSpecialist = createSpecialist({
  name: "math",
  description: "Arithmetic, calculations, equations, math word problems",
  role: "You solve math problems using the calculate tool.",
  tools: [/* calculate tool that runs eval-but-safe, e.g. mathjs-style */],
});

// Provider config from env (PROVIDER=compat with LLM_*, same as existing demos)
// ...

const result = await orchestrate({
  llm,
  routerModel: model,           // start with the same model for both
  specialistModel: model,
  specialists: [weatherSpecialist, mathSpecialist],
  services: {},
  message: process.argv[2] ?? "What's the weather in Tokyo?",
});

console.log(`[routed to: ${result.routedTo}] ${result.finalText}`);
```

Add `"demo:triage": "node --env-file-if-exists=.env --import tsx demo/triage.ts"` to `package.json` scripts.

Verify both directions:

```sh
PROVIDER=compat npm run demo:triage "what's the weather in oslo"   # should route → weather
PROVIDER=compat npm run demo:triage "what is 17 squared plus 4"   # should route → math
```

## §6 — Tests with `node:test`

### Setup

Add to `package.json`:

```json
"scripts": {
  "test": "node --import tsx --test test/**/*.test.ts"
}
```

No new deps. `tsx` is already a devDep.

### Mock LLMProvider helper

`test/_mock.ts` (underscore so node:test glob doesn't match it as a test file):

```ts
import type { LLMProvider, CompletionRequest, CompletionResponse, ContentBlock } from "../src/index.ts";

export function mockProvider(turns: CompletionResponse[]): LLMProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const res = turns[i] ?? turns[turns.length - 1];
      i++;
      return res;
    },
  };
}

export const text = (text: string): ContentBlock => ({ type: "text", text });
export const toolUse = (id: string, name: string, input: unknown): ContentBlock => ({
  type: "tool_use", id, name, input,
});
```

### `test/run.test.ts`

Cases (write each as a `test()` block, use `assert.strictEqual` / `assert.deepStrictEqual`):

1. **single text response** — provider returns `end_turn` with text only → `runAgent` returns `iterations=1, stopReason="end_turn", finalText` matches.
2. **single tool call → result → final text** — turn 1 returns `tool_use`, turn 2 returns text. Assert `iterations=2`, handler was called with parsed input, `tool_result` message threaded into messages array.
3. **parallel tool calls in one turn** — turn 1 returns 2 tool_use blocks. Assert both handlers called concurrently (both ran, both results appended). Two `tool_result` messages in transcript before turn 2.
4. **tool handler throws** — handler `throws new Error("boom")`. Assert `tool_result` has `isError: true`, content is `"boom"`. Loop continues (next turn returns text).
5. **unknown tool** — provider returns `tool_use` for a name not in `tools[]`. Assert `tool_result` has `isError: true, content: "Unknown tool: ..."`.
6. **max_iterations** — provider returns `tool_use` forever. Assert `runAgent` exits with `stopReason: "max_iterations"` after `maxIterations` turns.
7. **services threading** — handler asserts `ctx.services.foo === "bar"` (services passed through correctly).

### `test/router.test.ts`

1. **exact match** — mock provider returns text `"weather"`. Classify with intents `[weather, math]`. Assert `intent: "weather"`.
2. **case insensitive / trimmed** — mock returns `"  Weather\n"`. Assert resolves to `"weather"`.
3. **no match → fallback** — mock returns `"banana"`. Fallback `"math"`. Assert returns `"math"`.
4. **no match, no fallback → first** — mock returns `"banana"`, no fallback. Assert returns `intents[0].name`.
5. **history threading** — pass `history`, assert mock provider received those messages prepended.

### `test/specialist.test.ts`

1. **createSpecialist returns config unchanged** — sanity.
2. **runSpecialist passes role as system, with formatGuide appended** — assert mock received the expected `system` field.
3. **services flow through to tool handler** — handler receives `ctx.services`.
4. **specialist.model overrides defaultModel** — assert mock received the specialist's model.

### `test/orchestrate.test.ts`

1. **routes to correct specialist** — mock returns `"weather"` from router call, then turn 1 of specialist with text. Assert `routedTo: "weather"`.
2. **router and specialist use different models** — assert `mock.calls[0].model === routerModel`, `mock.calls[1].model === specialistModel`.
3. **specialist tools dispatch through** — full path: route → specialist invokes tool → tool result → final text. Use 3 mocked turns.
4. **fallback when router output unrecognized** — router returns garbage, orchestrator falls back, dispatches anyway.

### `test/adapters.test.ts`

No network. Just translation logic. **Important**: this requires extracting the translation functions (`toAnthropicMessage`, `toOpenAIMessages`, etc.) as `export`ed helpers from the adapter files, OR testing them indirectly via an `LLMProvider` whose `fetch` is monkey-patched.

Cleaner: extract the translation helpers to internal files (`src/llm/_anthropic-translate.ts`, `src/llm/_openai-translate.ts`) and have the adapters import them. Underscore prefix signals "internal but exported for testing."

Cases:
1. **Anthropic: tool_result message → user message with tool_result block**.
2. **Anthropic: assistant message with text + tool_use blocks → correct param shape**.
3. **OpenAI: assistant turn with tool_use blocks → message with tool_calls + reasoning_content empty string when tool_calls present**.
4. **OpenAI: tool_result → role:"tool" message with tool_call_id**.
5. **OpenAI: response with reasoning_content → reasoning block in normalized content** (the Kimi case we just hit).
6. **OpenAI: round-trip through translation preserves tool_use ids**.

This is the test suite that catches future adapter regressions when adding more providers.

## §7 — Verification gate

All must pass before considering Phase 2 done:

```sh
cd ~/Desktop/proteus
npx tsc --noEmit                 # typecheck clean
npm test                         # all node:test files green
PROVIDER=compat LLM_MODEL=glm-5.1 npm run demo         # weather still works
PROVIDER=compat LLM_MODEL=glm-5.1 npm run demo:multi   # parallel still works
PROVIDER=compat LLM_MODEL=glm-5.1 npm run demo:triage "what's the weather in oslo"
PROVIDER=compat LLM_MODEL=glm-5.1 npm run demo:triage "what is 17 squared plus 4"
```

Last two: confirm router picked the right specialist (output should include `[routed to: weather]` / `[routed to: math]`).

## §8 — Out of scope for this phase (do NOT add)

- Confirmation gate / WRITE_TOOLS taxonomy
- Caching strategy
- Streaming
- Channel adapters (Telegram, HTTP)
- Error taxonomy / `LLMError` class
- Cost tracking
- Multiple specialists running in parallel ("chain" / "parallel" orchestration modes from intrebit)
- Evaluator (response quality gate)
- Third LLM adapter

These are Phase 3+. Resist scope creep. The point of Phase 2 is proving the *architecture* (router + specialist + ToolContext) works on the existing provider abstraction.

## §9 — Recommended order of execution

1. `src/agent/context.ts` (10 lines, 5 min)
2. Refactor `src/agent/run.ts` to use `ToolContext` + update existing demos. Run typecheck + existing demos to confirm no regression.
3. `src/agent/specialist.ts`.
4. `src/agent/router.ts`.
5. `src/agent/orchestrate.ts`.
6. `demo/triage.ts` + add npm script.
7. Manually run triage demo against GLM, confirm both routes work.
8. `test/_mock.ts` + `test/run.test.ts`. Make tests pass.
9. `test/router.test.ts`, `test/specialist.test.ts`, `test/orchestrate.test.ts`. Make pass.
10. (Optional) extract translation helpers + `test/adapters.test.ts`. Skip if time-constrained — the smoke demo already exercises the translation paths.
11. Commit. Don't push until verification gate is fully green.

## §10 — Update CLAUDE.md when done

Add a section under "Architecture" describing the new layers: `ToolContext<TServices>`, `Specialist`, `Router`, `Orchestrator`. Move "What does *not* belong here yet" forward — move router/specialist out of that list, leave the rest.

## Reference files in intrebit (read-only, for prior art)

- `intrebit/agents/operator/src/claude/router.ts` — the router we're porting.
- `intrebit/agents/operator/src/claude/specialists/base.ts` — specialist loop pattern, much heavier than what we need.
- `intrebit/agents/operator/src/claude/orchestrator.ts` — has chain/parallel modes; we only need single-shot dispatch.
- `intrebit/agents/operator/src/claude/specialists/index.ts` — how intents map to specialists.

Read these for shape, port aggressively simplified versions. **Do not copy CRM-specific code.**
