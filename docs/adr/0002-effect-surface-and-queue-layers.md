# ADR 0002 — Effect Layers for PR-surface I/O and the review queue

## Status

Accepted. Superseded in part by [ADR 0009](0009-durable-agent-work.md) for durable review/ask work execution.

## Context

After the Effect migration (commit `26d6cc2`, ADR-0001), two seams still lived outside the Layer paradigm:

1. **PR-surface I/O** — `src/github/{comments, reactions, prMeta, botFacade}.ts` formed a quartet of single-purpose modules around Octokit. `commands/registry.ts` had begun importing `comments.ts` directly, bypassing `botFacade.ts` — a sign that the facade was already half-used and that "things this app does to a PR conversation, an issue comment, or an inline review thread" had no single seam to extend or test against.

2. **Review concurrency** — `src/agent/reviewQueue.ts` was a module-scoped FIFO singleton (mutable `active`, `maxConcurrent`, `waiters`). Every other piece of concurrency state in the app (`DeliveryDedupe`, `GithubInstallationToken`, `BotIdentity`) was already a `Layer.effect` with `Ref.modify` / `Deferred` discipline. The queue forced callers to remember a free-function wrapper.

Both concepts wanted the same shape — an Effect `Layer` exposing a `Context.Tag` — but were stuck mid-migration.

## Decision

1. **`PrGithubSurface`** is the sole seam for GitHub I/O from webhook handlers. It is a `Context.Tag` with verbs named from `CONTEXT.md`: `acknowledgeOnPrConversation`, `acknowledgeOnIssueComment`, `acknowledgeOnReviewComment`, `postPrConversationComment`, `replyOnInlineReviewThread`, `getPullRequestHeadSha`. The 422 / 403 reaction-swallow lives inside the surface as an internal helper. The auth seam (`installationOctokit` in `src/github/appAuth.ts`) is unchanged and reused.

   The `@github-tools/sdk` `code-review` preset (used by the agent's tool loop in `src/agent/reviewRun.ts`) remains a separate path. The preset has no reactions, no inline-thread reply, and no head-SHA-as-tool; it is not interchangeable with the webhook-handler surface.

2. **`ReviewQueue`** is a `Context.Tag` exposing `submit<A, E>(label, task: Effect<A, E>): Effect<A, E>`. `ReviewQueueLive(cfg)` is a factory because the semaphore size is taken from `cfg.reviewConcurrency`. Backed by `Effect.makeSemaphore(cfg.reviewConcurrency).withPermits(1)`.

3. **`buildWebhookDispatcherLive(cfg)`** replaces the prior `WebhookDispatcherLive` constant so that cfg can flow into `ReviewQueueLive(cfg)`. Three tests that referenced the constant were updated accordingly.

4. **ADR-0001 parse-first boundary** is unchanged; durable dedupe and worker-time tokens are defined in [ADR 0009](0009-durable-agent-work.md).

## Consequences

- **Test isolation.** Each Layer instantiation is fresh; tests provide their own `PrGithubSurface` / `ReviewQueue` mocks via `Layer.succeed`. The previous module-global queue test (`test/reviewQueue.test.ts`) is replaced by `test/reviewQueueLayer.test.ts`.

- **FIFO is not guaranteed.** `Effect.makeSemaphore` does not contractually guarantee strict FIFO wakeup. The new test asserts **cap** (never exceeds `reviewConcurrency` in flight) and **completeness** (every submitted task finishes); it does **not** assert that tasks start in submission order. The prior module-scope queue happened to be FIFO via a JS array; that incidental property is gone.

- **`runFullPrReview` is still Promise-based.** Inside the new Effect handlers it is wrapped in `Effect.tryPromise`. Effect cancellation does **not** propagate into the Pi-AI tool loop. This was already true before this change; flagged here so it is not later miscredited as a regression.

- **Webhook handlers are uniformly Effect.** `src/webhook/handlers/*.ts` is gone; the three handler bodies live inline inside `WebhookHandlersCore` (`src/effect/services/webhookHandlers.ts`). The slash flow lives in `src/commands/slashCommandFlow.ts` parameterised by a `ReplyTarget` variant, removing the prior mirror-image duplication between `issueComment.ts` and `pullRequestReviewComment.ts`.

- **Production slash routing (ADR 0009).** Webhook slash commands are handled by [`AgentWorkScheduler`](../../src/agentWork/scheduler.ts), not `slashCommandFlow`. `slashCommandFlow`, `ReviewQueue`, and `AskQueue` remain for unit tests of slash parsing and in-process concurrency caps.

- **In-process semantics preserved.** Both seams remain per-process. ADR-0001's at-least-once delivery acceptance under multi-replica deployment is unchanged.

## Reversal

Per-commit `git revert` is granular:

- Reverting the `ReviewQueue` commit restores `src/agent/reviewQueue.ts` and the `configureReviewQueue` call in `src/index.ts`. The dispatcher returns to a constant `WebhookDispatcherLive`. Slash flow and `pullRequest` handler revert to `runQueuedReview(label, async-fn)`.
- Reverting the `PrGithubSurface` commit restores the `github/{botFacade, comments, reactions, prMeta}.ts` quartet and the three promise-based handler files; `WebhookHandlersCore` returns to `runPromiseHandler` glue.

Reversing the broader direction (returning to module-scoped state for these seams) should be discussed because it would re-introduce the test-isolation and discoverability problems that motivated this ADR.
