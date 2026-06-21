# ADR 0008 — `/ask` command (Q&A via tool loop)

## Status

Accepted. Superseded in part by [ADR 0009](0009-durable-agent-work.md) for execution, concurrency, and webhook response timing. The in-process `AskQueue` Effect semaphore described in early revisions is removed; production uses pg-boss workers only.

## Context

Contributors and reviewers need to ask ad hoc questions about PR code (for example, "what is this hook for?") without triggering a full review. Upstream [qodo-pr-agent](https://github.com/qodo-ai/pr-agent) implements `/ask` as a single LLM call with the PR diff (or selected diff hunk for inline comments) embedded in the prompt.

This repo already runs reviews through a Pi-AI tool loop with native GitHub REST tools ([ADR 0004](0004-native-pi-ai-toolset.md)). Bounded concurrency was first expressed as Effect Layers ([ADR 0002](0002-effect-surface-and-queue-layers.md)); production now uses pg-boss workers ([ADR 0009](0009-durable-agent-work.md)).

## Decision

1. **`/ask` slash command** on `issue_comment` and `pull_request_review_comment` (`created` only), parsed on the first non-empty line like other commands.

2. **Tool-loop investigation** — Ask runs call GitHub tools (`listPullRequestFiles`, `getFileContent`, `searchCode`, etc.) and Context7 doc lookup when needed. The model does not receive the full PR diff upfront. When the webhook includes a **code anchor** (inline review comment), path, line range, and `diff_hunk` are injected into the user message as the starting point.

3. **Separate ask lane** — Ask runs enqueue on pg-boss `agent-work-ask` with worker `localConcurrency` from `ASK_CONCURRENCY` (default **1**), not the review queue, so interactive Q&A does not share review worker slots.

4. **Split reply format** (matches upstream UX):
   - **Inline review thread:** plain answer only.
   - **PR conversation:** `**Question:**` / `**Answer:**` wrapper.

5. **Stateless** — Each ask run is independent; prior `/ask` commands or thread history are not loaded.

6. **Failure handling** — One retry nudge, then text-only fallback, then an honest short failure reply if still stuck.

7. **Style** — System prompt requires simple, humane prose with no em dashes and no AI-tell openers; enforcement is prompt-only (no post-processing).

## Consequences

- Ask runs may take longer than upstream's single-call `/ask` but can trace symbols across the repo beyond the inline hunk.
- The webhook returns **`200`** after durable intake and enqueue; the ask **answer** is posted asynchronously by `ROLE=worker`. If intake exceeds the configured webhook response budget, the request returns **`503`** before GitHub reports a delivery timeout.
- `CONTEXT.md` gains **Ask run**, **Ask queue**, and **Code anchor** terms distinct from review vocabulary.

## Current implementation (2025-05)

- Production routing: [`AgentWorkScheduler.submitSlashCommand`](../../src/agentWork/scheduler.ts) → `agent-work-ask` job → [`runAskRun`](../../src/agent/ask/askRun.ts) in the worker.

## Reversal

Remove `/ask` handling from [`scheduler.ts`](../../src/agentWork/scheduler.ts), delete `askRun` and the ask worker subscription, and revert webhook schema extensions for review-comment anchor fields.
