# 0008 — HTTP suspend/resume for the confirmation gate

- **Status**: Accepted
- **Date**: 2026-05-03

## Context

The per-tool confirmation gate (ADR-less, see CLAUDE.md) gates a `ToolDef` flagged `requiresConfirmation: true` through an in-process `ConfirmCallback`. That works for the CLI demo and the Telegram long-poll transport (both of which have a long-lived process that can `await` user input). It does not work for the HTTP channel — `createChatHandler` is a single-shot request/response function, and there is nowhere to park a pending action between the moment the LLM emits `tool_use` and the moment a human responds.

Today, configuring an HTTP handler with confirm-required tools means either:

- Provide no `confirm` callback → every gated tool short-circuits to a `[CONFIRM-MISSING]`-style error tool_result. The model sees the failure and recovers, but the action is never actually offered to the user. This is the silent-failure path.
- Provide an in-process `confirm` callback → it runs inside the request handler with no human in the loop. Defeats the purpose.

Either way, destructive tools are unusable on HTTP. CRM-style consumers (intrebit, the canonical reference) cannot adopt the framework without this.

## Decision

Suspend/resume across HTTP requests, persisted via a new `PendingStore`. Three layers change:

### Agent loop (`src/agent/run.ts`)

`ConfirmCallback` return type widens to `Promise<boolean | "pending">`. When a callback returns `"pending"`, `runAgent` exits early with `stopReason: "pending"` and a `suspended: SuspensionPayload` describing:

- the current `pending` tool (toolUseId + name + input + summary),
- the conversation `messages` *before* the assistant turn that triggered the gate,
- the assistant turn's `turnContent` (so the same tool_use blocks can be re-presented on resume),
- a `decided` map of toolUseId → `ToolResultRecord` for any tools in the same turn that already resolved (non-confirm tools that ran inline, or earlier confirms in the same turn that resolved as approve/decline).

A new `resumeAgent({ ..., suspended, resume: { toolUseId, decision } })` rebuilds the loop state, applies the explicit decision, re-runs the per-turn dispatcher (which may itself suspend again on the next confirm-required tool — supported), then re-enters the main loop where it left off.

The dispatch logic that handles "gate then run" was extracted from `runAgent` into a single internal `dispatchTurn` so both fresh and resumed runs share one code path.

### Specialist + orchestrate

`resumeSpecialist` and `resumeOrchestrate` mirror their fresh counterparts, but skip the router (the chosen specialist is recorded in the persisted `PendingRecord`). Re-routing on resume would be wrong — the user is responding to a specific action the framework offered them, not starting a new turn.

### Channel layer (`src/channel/http.ts`)

`createChatHandler` config gains an optional `pendingStore?: PendingStore`. The new `PendingStore` is a sibling of `SessionStore`, not an extension — they have different lifecycles (one persists conversation history forever, the other holds at most one pending record per session and is cleared on resolution).

When `pendingStore` is configured:

- The handler's effective `confirm` callback unconditionally returns `"pending"`. This means *every* confirm-required tool suspends — there is no in-process answer for HTTP.
- `ChatRequest` gains optional `confirm?: { decision: "approve" | "decline" }`.
- `ChatResponse` becomes a discriminated union: `ChatReply { kind: "reply", reply, routedTo }` | `ChatPending { kind: "pending", routedTo, toolUseId, name, summary }`.
- Behavior:
  - Pending exists, no decision → return the existing pending unchanged (no LLM call).
  - Pending exists, decision present → resume via `resumeOrchestrate`. May itself suspend again or return a reply.
  - No pending → fresh `orchestrate`. May suspend.
- Persistence rule from ADR 0002 unchanged: only the user/assistant text pair is appended to `SessionStore`. The pending state is held exclusively in `PendingStore` and cleared on resolution.

The streaming chat handler does **not** support suspend/resume in v1. SSE is mid-response; suspending mid-stream means breaking the response with no clean way to surface the pending payload as part of the same connection. Streaming consumers needing destructive tools should use the buffered handler today.

`inMemoryPendingStore()` ships as the default. Real backends (Postgres, Redis) implement the same `get`/`set`/`clear` interface.

### Limitations recorded in v1

- **Streaming**: deferred (above).
- **Multiple confirm-required tools per turn**: supported, but each takes a separate roundtrip — the handler suspends on the first, resumes, may suspend on the second, and so on. No batched approval shape.
- **Re-routing on resume**: explicitly not supported. The pending record locks the specialist.
- **Time-to-live on pending records**: out of scope. Consumers wanting expiry wrap the store.

## Consequences

- HTTP becomes a first-class channel for destructive tools. The pattern intrebit (and any CRM-style consumer) needs is now expressible without lifting the gate into user code.
- `ConfirmCallback` signature change is non-breaking: `boolean` is still a valid return. Existing callers untouched.
- `ChatResponse` becoming a union is breaking for callers that destructure `result.reply`. Demo + tests updated; consumers will need a one-line `if (out.kind === "reply")` narrowing. The win — being able to *see* the pending case — outweighs the import-day pain.
- The agent-side `SuspensionPayload` is structural and can be persisted as JSON. Real backends can store it as a single column.
- The pending-confirm wrapping inside the channel means the consumer cannot also pass a non-pending `confirm` callback when `pendingStore` is set. That's a deliberate scope limit: mixing in-process and persisted confirms in the same handler invites incoherent state.
