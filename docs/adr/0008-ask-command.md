# ADR 0008 — `/ask` command (Q&A via tool loop)

## Status

Accepted. Ask runs are executed by pg-boss workers ([ADR 0009](0009-durable-agent-work.md)); the `AskQueue` Effect semaphore described below is superseded for production.

## Context

Contributors and reviewers need to ask ad hoc questions about PR code (for example, "what is this hook for?") without triggering a full review. Upstream [qodo-pr-agent](https://github.com/qodo-ai/pr-agent) implements `/ask` as a single LLM call with the PR diff (or selected diff hunk for inline comments) embedded in the prompt.

This repo already runs reviews through a Pi-AI tool loop with native GitHub REST tools ([ADR 0004](0004-native-pi-ai-toolset.md)) and bounded concurrency via durable workers ([ADR 0009](0009-durable-agent-work.md)).

## Decision

1. **`/ask` slash command** on `issue_comment` and `pull_request_review_comment` (`created` only), parsed on the first non-empty line like other commands.

2. **Tool-loop investigation** — Ask runs call GitHub tools (`listPullRequestFiles`, `getFileContent`, `searchCode`, etc.) and Context7 doc lookup when needed. The model does not receive the full PR diff upfront. When the webhook includes a **code anchor** (inline review comment), path, line range, and `diff_hunk` are injected into the user message as the starting point.

3. **Separate AskQueue** — Ask runs use `AskQueue` with `ASK_CONCURRENCY` (default 3), not `ReviewQueue`, so interactive Q&A does not compete with review runs for the same semaphore.

4. **Split reply format** (matches upstream UX):
   - **Inline review thread:** plain answer only.
   - **PR conversation:** `**Question:**` / `**Answer:**` wrapper.

5. **Stateless** — Each ask run is independent; prior `/ask` commands or thread history are not loaded.

6. **Failure handling** — One retry nudge, then text-only fallback, then an honest short failure reply if still stuck.

7. **Style** — System prompt requires simple, humane prose with no em dashes and no AI-tell openers; enforcement is prompt-only (no post-processing).

## Consequences

- Ask runs may take longer than upstream's single-call `/ask` but can trace symbols across the repo beyond the inline hunk.
- Synchronous webhook contract unchanged; large asks may exceed `WEBHOOK_TIMEOUT_MS` (logging-only budget).
- `CONTEXT.md` gains **Ask run**, **Ask queue**, and **Code anchor** terms distinct from review vocabulary.

## Reversal

Remove `/ask` handling from `slashCommandFlow`, delete `askRun` / `AskQueue`, and revert webhook schema extensions for review-comment anchor fields.
