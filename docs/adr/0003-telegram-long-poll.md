# 0003 — Telegram channel: long-poll first, webhook deferred

- **Status**: Accepted
- **Date**: 2026-05-02

## Context

Telegram bots can receive updates two ways: **long-polling** (`getUpdates`, outbound HTTPS only) or **webhook** (Telegram POSTs to a public TLS endpoint, with secret-token verification). Both consume the same `Update` payload.

Proteus is a portfolio PoC that needs to run on a laptop, in CI, and in a single throwaway VM with equal ease. Webhooks require a public hostname, valid TLS, and a long-lived process; long-polling requires only an outbound socket.

## Decision

Ship `runPolling` only. Export `processUpdate(update, deps)` as a separate pure function so a webhook adapter can be added later as a ~10-line wrapper:

```ts
// hypothetical webhook handler
async (req) => processUpdate(await req.json(), deps);
```

The two-function split is the load-bearing part of this ADR. Long-poll vs webhook is the easy part — what matters is that update mapping and reply formatting live in `processUpdate`, not in the loop.

## Consequences

**Buys**
- PoC runs anywhere with outbound HTTPS. No reverse proxy, no TLS cert, no public DNS.
- Tests exercise update mapping without mocking a poll loop.
- Webhook is a small additive change when a real consumer needs it.

**Costs**
- Long-poll is exclusive: one process per bot token. Webhook unblocks horizontal scale; that's a real-consumer concern.
- A crashed process loses in-flight updates until restart picks them up via `offset` (Telegram retains 24h).

**Locks out**
- Nothing. Webhook lands without touching `processUpdate`.

## ADR 0001 reality-check

ADR 0001 claimed Telegram would land as a "30-line wrapper". The honest number is ~120 lines once update filtering, error handling, backoff, truncation, abort-signal, and fetch injection are all present. ADR 0001's "Costs" section has been softened — the wrapper claim now reads "thin enough to be a single file with no new deps", without the line count.
