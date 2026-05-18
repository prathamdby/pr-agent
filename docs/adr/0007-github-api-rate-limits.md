# ADR 0007 — GitHub API rate limits and resilient review tooling

## Status

Accepted.

## Context

Large PR reviews drive many GitHub REST/GraphQL tool calls in a single synchronous webhook. Production observed sustained `Bad credentials` errors during bursts; root cause was not proven, but the failure mode matches rate-limit / secondary-limit pressure (see [issue #9](https://github.com/prathamdby/pr-agent/issues/9)).

`@octokit/plugin-retry` alone does not pace requests or honor `Retry-After` for secondary limits.

## Decision

1. **Global throttling** — Compose `@octokit/plugin-throttling` with `@octokit/plugin-retry` on every `installationOctokit()` instance (review tools, publish, PR-surface I/O). Plugin order: `retry`, then `throttling` (throttling outermost).

2. **Hook policy**
   - `onRateLimit`: retry when `retryCount < 2` (two retries).
   - `onSecondaryRateLimit`: retry only when `retryAfter > 0` and `retryCount === 0`.

3. **Structured logging** — On tool failure, log `github_tool_request_error` with status, `x-github-request-id`, `x-ratelimit-*`, `retry-after`, token age, and classification. Never log tokens.

4. **App-layer classification** — After the plugin exhausts retries, classify errors (`rate_limit`, `secondary_rate_limit`, `probable_secondary` for young-token `Bad credentials`, `token_expired`, `auth`, `other`). Inject cooldown text into `toolResult` for rate classes.

5. **Circuit breaker** — After 3 consecutive classified rate-limit failures in one review run, short-circuit non-`submitReview` GitHub tools for the remainder of the run; nudge the model to call `submitReview`.

6. **`listPullRequestFiles`** — Server-side pagination (`per_page: 100`), caps `MAX_PR_FILES_LISTED` (default 300) and `MAX_PR_FILES_PATCH_BYTES` (default 500_000). Remove client `page`/`perPage` from the tool schema.

7. **Prompt discipline** — Prefer patches from `listPullRequestFiles`; limit `searchCode` / `getBlame`.

## Consequences

- Reviews on large PRs may run longer (throttle waits); synchronous webhook contract unchanged; `WEBHOOK_TIMEOUT_MS` remains logging-only.
- Truncated PRs (>300 files) degrade review coverage by design.
- Throttle state is per-process; `REVIEW_CONCURRENCY > 1` or multi-replica deploys can still burst the same installation.
- `probable_secondary` is a heuristic; use structured logs to disprove in production.

## Deferred

- Async webhook ack (early `200`).
- Mid-review installation token re-mint.
- Cross-process rate-limit coordination (Redis Bottleneck clustering).
