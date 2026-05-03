# Architecture Decision Records

Short, append-only log of load-bearing design choices. One file per decision.

## Format

Nygard-lite. Each ADR:

```
# NNNN — Title

- **Status**: Proposed | Accepted | Superseded by NNNN | Deprecated
- **Date**: YYYY-MM-DD

## Context
What forced this decision. The constraint, the option space.

## Decision
What we chose. Imperative voice.

## Consequences
What this buys us, what it costs, what it locks out.
```

Numbering is sequential, zero-padded to 4 digits. Never renumber.

## Conventions

- One decision per file. If a decision changes, write a new ADR with `Supersedes NNNN` and flip the old one to `Superseded by ...`.
- Decisions about *building blocks* go here (provider abstraction, channel design, store interface). Decisions about *style* go in `CLAUDE.md`.
- Pre-ADR decisions live in `CLAUDE.md`'s Architecture section. Backfill an ADR only when a new decision needs to point at the old one.

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-http-channel-adapter-first.md) | HTTP-shaped channel adapter before Telegram | Accepted |
| [0002](./0002-pluggable-session-store.md) | Pluggable `SessionStore` for channel history | Accepted |
| [0003](./0003-telegram-long-poll.md) | Telegram long-poll first | Accepted |
| [0004](./0004-streaming.md) | Streaming: provider + runAgent only | Accepted |
| [0005](./0005-channel-streaming.md) | Channel-layer streaming: HTTP SSE handler | Accepted |
| [0006](./0006-error-taxonomy.md) | Typed `LLMError` hierarchy from adapters | Accepted |
| [0007](./0007-retry-wrapper.md) | Retry wrapper above the provider, not inside adapters | Accepted |
