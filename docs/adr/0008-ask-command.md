# ADR 0008 — `/ask` command and conversational mentions

## Status

Accepted. Superseded in part by [ADR 0009](0009-durable-agent-work.md) for execution, concurrency, and webhook response timing. The in-process `AskQueue` Effect semaphore described in early revisions is removed; production uses pg-boss workers only. [ADR 0022](0022-thread-reply-classification-worker.md) (bare thread-reply classification behind `ENABLE_THREAD_REPLIES`) is superseded by always-on `@bot` mention intake on this ask path. Durable admission limits for both triggers are defined in [ADR 0039](0039-ask-admission-quotas.md).

## Context

Contributors and reviewers need to ask ad hoc questions about PR code (for example, "what is this hook for?") and to follow up on inline findings ("why is this a P0?") without triggering a full review. Upstream [qodo-pr-agent](https://github.com/qodo-ai/pr-agent) implements `/ask` as a single LLM call with the PR diff (or selected diff hunk for inline comments) embedded in the prompt.

This repo already runs reviews through a Pi-AI tool loop with native GitHub REST tools ([ADR 0004](0004-native-pi-ai-toolset.md)). Bounded concurrency was first expressed as Effect Layers ([ADR 0002](0002-effect-surface-and-queue-layers.md)); production now uses pg-boss workers ([ADR 0009](0009-durable-agent-work.md)).

## Decision

1. **Triggers** — `/ask` slash command on `issue_comment` and `pull_request_review_comment` (`created` only), parsed on the first non-empty line like other commands; **or** an `@`-mention of the app bot login (and optional slug without `[bot]`) anywhere on those surfaces, subject to the same association allowlist as slash commands. Bare non-mention replies do not enqueue ask work.

2. **Tool-loop investigation** — Ask runs call local workspace tools and Context7 doc lookup when needed. The model does not receive the full PR diff upfront. When the webhook includes a **code anchor** (inline review comment), path, line range, and `diff_hunk` are injected into the user message as the starting point.

3. **Thread transcript** — Before the LLM turn, the ask worker loads the containing comment thread (inline review comments grouped by root, or PR conversation thread when `in_reply_to_id` is available) and injects it as untrusted `thread_transcript` context. Fetch failures soft-degrade to question-only. A char cap keeps oversized threads bounded (root + newest tail).

4. **Separate ask lane** — Ask runs enqueue on pg-boss `agent-work-ask` with worker `localConcurrency` from `ASK_CONCURRENCY` (default **1**), not the review queue, so interactive Q&A does not share review worker slots.

5. **Split reply format** (matches upstream UX):
   - **Inline review thread:** plain answer only.
   - **PR conversation:** `**Question:**` / `**Answer:**` wrapper.

6. **Explain-only** — Ask runs do not change finding severity, dismiss findings, resolve threads, or edit review summaries.

7. **Failure handling** — One retry nudge, then text-only fallback, then an honest short failure reply if still stuck.

8. **Style** — System prompt requires simple, humane prose with no em dashes and no AI-tell openers; enforcement is prompt-only (no post-processing).

## Consequences

- Ask runs may take longer than upstream's single-call `/ask` but can trace symbols across the repo beyond the inline hunk and continue a natural conversation in-thread.
- The webhook returns **`200`** after durable intake and enqueue; the ask **answer** is posted asynchronously by `ROLE=worker`. If intake exceeds the configured webhook response budget, the request returns **`503`** before GitHub reports a delivery timeout.
- `CONTEXT.md` **Ask run** documents mention triggers and thread context.

## Current implementation

- Production routing: [`AgentWorkScheduler.submitSlashCommand`](../../src/agentWork/scheduler.ts) → `agent-work-ask` job → [`runAskRun`](../../src/agent/ask/askRun.ts) in the worker (thread load in [`askExecutor`](../../src/agentWork/executors/askExecutor.ts)).
- Mention detection: [`parseBotMention`](../../src/commands/parseBotMention.ts) + webhook handlers.

## Reversal

Remove mention handling from [`webhookHandlers.ts`](../../src/effect/services/webhookHandlers.ts), drop thread transcript loading from the ask executor, and revert ask prompt/user-content changes.
