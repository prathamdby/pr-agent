# ADR 0022 — Asynchronous thread-reply classification

## Status

Superseded by conversational `@bot` mention intake on the ask path ([ADR 0008](0008-ask-command.md)). The `ENABLE_THREAD_REPLIES` flag, `agent-work-thread-classify` queue, and classify worker were removed.

## Context (historical)

When `ENABLE_THREAD_REPLIES=true`, a non-slash reply in a bot inline review thread became an implicit `/ask`. Classification ran asynchronously so the webhook fiber stayed DB-only ([ADR 0009](0009-durable-agent-work.md)).

## Replacement

Always-on `@`-mention of the app bot (same slash association allowlist) on PR conversation or inline review comments enqueues ask intake directly. Ask workers load full containing-thread context. Bare replies without a mention are ignored.

## Reversal

Not recommended. Prefer the mention + thread-transcript ask path in ADR 0008.
