# Intrebit migration — session handoff

Companion to `intrebit-gaps.md` (now out of date — the gaps shipped). This
doc is the starting brief for the **next** session: doing the actual
wholesale swap of `intrebit/agents/core` → proteus.

## State coming into the next session

### Proteus (~/Desktop/proteus, branch `feat/router-specialist`)

All gap-close PRs merged. Surface ready for intrebit consumption:

- LLM providers: `anthropic`, `openaiCompat` (both with `complete` + `stream`)
- Typed errors: `LLMAuthError | LLMRateLimitError | LLMBadRequestError | LLMServerError | LLMTransportError | LLMStreamError`, `withRetry` wrapper
- `runAgent` / `streamAgent` / `resumeAgent` (suspend/resume confirm gate)
- `Specialist` + `runSpecialist` / `streamSpecialist` / `resumeSpecialist`
- `classifyIntent` returning `{ intents, mode, reasoning, usage }` — multi-intent + lenient JSON parse (PR #12)
- `orchestrate` / `streamOrchestrate` / `resumeOrchestrate` — single + chain + parallel (PR #12)
- Evaluator gate (single mode only)
- Anthropic prompt caching hints (`cacheSystemPrompt`, `cacheBreakpoint`, `Specialist.cacheRole`)
- `Usage.cacheCreationInputTokens?` / `cacheReadInputTokens?` metering
- Tool concurrency cap (`toolConcurrency`) + `mapLimit` helper (PR #13)
- `trimToBudget` session history helper (PR #13)
- Channel layer: `createChatHandler`, `createStreamingChatHandler`, `SessionStore`, `PendingStore`, Telegram `processUpdate`/`runPolling`/`createWebhookHandler`
- 217 tests, all green

### Intrebit (~/Desktop/intrebit/agents)

Read but not modified. Reference files (verified during recon):

- `operator/src/claude/router.ts` — single-call CRM-domain router (intents enum hardcoded)
- `operator/src/orchestrator.ts` — chain (lines 49-65) + parallel (32-48) dispatch + evaluator retry (79-120)
- `operator/src/claude/specialists/base.ts` — specialist tool loop with `mapLimit(3)` for tool concurrency
- `operator/src/claude/client.ts` — `executeToolWithConfirmation` (DB-backed pending), `toolResultForLlm` (XML wrap), `WRITE_TOOLS` set
- `operator/src/memory/pending-actions.ts` — `ON CONFLICT DO NOTHING` first-write-wins
- `operator/src/memory/session.ts` — `trimToTokenBudget` (proteus equivalent now exists)
- `core/src/anthropic.ts` — Anthropic + lmstudio adapter (proteus has equivalents)
- `core/usage.ts` — usage tracker with cost estimation + budget alerts
- `core/ops.ts` — Telegram ops channel

### Workspace structure (intrebit)
- `core` — replaceable in whole/part by proteus
- `operator` — primary consumer (router + specialists + handler)
- `worker` — bg jobs, rate limit
- `watchdog` — process supervision
- `librarian-lib` — knowledge vault Q&A

## Migration strategy (locked decisions)

- **Wholesale swap, not gradual.** Pre-prod, no BWC.
- **`file:` dep first**, npm publish later. Use `"@fole/proteus": "file:../../proteus"` in `intrebit/agents/operator/package.json` (and `core/package.json` if anything still imports core during transition).
- **Confirmation model**: intrebit migrates UX to proteus's suspend/resume (ADR 0008). The "queue with [PENDING_CONFIRMATION] tool_result" flow goes away — pending state is held in `PendingStore`, channel handler returns `kind: "pending"`, user's next message resumes via `resumeOrchestrate`.
- **Stays in intrebit** (do NOT migrate to proteus):
  - CRM tools + schemas (`operator/src/claude/{client.ts, schemas.ts}` handlers, Zod schemas)
  - All specialists (`operator/src/claude/specialists/*.ts`) — they become `Specialist<TServices>` factories using proteus's `createSpecialist`
  - Router system prompt body (CRM-domain categories) — proteus's router takes intent list as a param, intrebit injects the CRM intents
  - `WRITE_TOOLS` set + per-tool `requiresConfirmation: true` flag (proteus has this on `ToolDef`)
  - `<untrusted_crm_data>` XML wrapping (intrebit-policy, lives in tool handler return values)
  - DB-backed `SessionStore` + `PendingStore` implementations (proteus exports the interfaces)
  - Telegram relay wiring, config, ops/usage tracking, fail-log, last-turn memory

## First steps for the next session

### 0. Orient
1. `cd ~/Desktop/intrebit/agents && cat package.json` — check workspace layout, current deps
2. `ls operator/src/{claude,memory}/` — verify file paths haven't drifted since recon
3. `cd ~/Desktop/proteus && git log --oneline -5` — confirm head matches handoff (`6e14625`)

### 1. Decide the dep wiring
Two options:
- **A1.** Add proteus as `"@fole/proteus": "file:../../proteus"` in `operator/package.json` only. Leave `core` package alone for now; rip it out per file as imports flip.
- **A2.** Replace `core` package's exports with re-exports from proteus, leave operator imports untouched. Less file churn but keeps `core` as a thin shim.

A1 is the more honest swap (matches "wholesale" intent). Recommend A1.

### 2. Tag-along migration order (per file)
Touch in this order to minimize cascading breakage:

1. **`operator/src/claude/specialists/base.ts`** — replace the hand-rolled tool loop with `runSpecialist({ specialist, llm, ... })`. Each specialist's `runSpecialist` (intrebit's name, conflicts with proteus's) becomes a thin wrapper or is dropped entirely.
2. **`operator/src/claude/router.ts`** — replace with `classifyIntent` from proteus. Keep the keyword fast-path locally (CRM-specific phrases). Inject the CRM intent list into proteus's generic prompt.
3. **`operator/src/orchestrator.ts`** — replace chain/parallel/evaluator dispatch with proteus's `orchestrate`. The chain XML format and parallel separator already match.
4. **`operator/src/claude/client.ts`** — `executeToolWithConfirmation` collapses into proteus's `ConfirmCallback` + `PendingStore` integration. `WRITE_TOOLS` becomes per-tool `requiresConfirmation: true`. `toolResultForLlm` XML wrap moves into the individual tool handlers (or a thin wrapper applied where they're constructed).
5. **`operator/src/memory/{session,pending-actions}.ts`** — wrap into `SessionStore` + `PendingStore` impls. Schemas + SQL queries unchanged.
6. **`operator/src/handler.ts`** — switch from manual orchestration to `createChatHandler({ ..., pendingStore, sessionStore, ... })`. The "yes"/"no" string-match logic in handler is REPLACED by proteus's resume flow — channel handler returns `{ kind: "pending" }`, next user message with `confirm: { decision }` resumes.
7. **`operator/src/telegram-relay.ts`** — switch to proteus's `processUpdate` + telegram bits.
8. **`core/src/*`** — delete files as imports flip. Final state: `core` package gone or empty.

### 3. Verification
- `cd intrebit/agents && pnpm install && pnpm typecheck && pnpm test` after each major file flip
- E2E smoke: run the operator against a staging CRM key, send a compound request ("find Andrej and show his deals") through Telegram → verify chain dispatch + final response

## Friction to watch for

- **Type collisions**: `runSpecialist` exists in both. Use named imports (`runSpecialist as proteusRunSpecialist`) during transition.
- **`AnthropicMessageParam` vs proteus `Message`**: intrebit speaks the Anthropic SDK shape directly in places. Replace those usages with proteus's normalized `Message`.
- **`ChatMessage` vs proteus `Message`**: intrebit's session schema is `{ role: "user" | "assistant"; content: string }`. Proteus's history is the richer normalized shape but accepts the simpler form for user messages. The session DB schema can stay as-is; map at the boundary.
- **Confirmation UX shift**: the "[PENDING_CONFIRMATION] / [ANOTHER_ACTION_PENDING]" tool-result strings the model sees today disappear. Specialist prompts that reference these strings need editing.
- **Evaluator + chain mode**: proteus rejects `evaluate` with `mode: "chain"`. Intrebit currently runs evaluator on chain. Either drop the evaluator on chain calls in intrebit, or build the chain-evaluator support in proteus first (small scope: re-run last specialist with feedback, no chain context).

## Out of scope for the migration session (defer)

- Cost estimation + budget alerts (intrebit `core/usage.ts`) — stays consumer-side, may eventually become a tiny proteus helper
- Streaming for chain/parallel modes — defer until intrebit needs it
- Publishing proteus to npm — after migration shakes out the API
- Removing intrebit's keyword fast-path router — it's a perf win, keep it as a pre-`classifyIntent` short-circuit

## Useful pointers

- Proteus CLAUDE.md (`~/Desktop/proteus/CLAUDE.md`) — current architecture + invariants
- Proteus ADRs (`~/Desktop/proteus/docs/adr/`) — every load-bearing decision
- `intrebit-gaps.md` (this dir) — original gap-analysis plan, now historical
- The verbatim recon excerpts of intrebit code live only in this conversation's history; if you re-explore, target the file paths listed under "Intrebit reference files" above
