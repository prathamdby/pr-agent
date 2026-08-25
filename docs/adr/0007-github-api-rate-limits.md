# ADR 0007 — GitHub API rate limits and resilient review tooling

## Status

Accepted. Superseded in part by [ADR 0009](0009-durable-agent-work.md) for async webhook acknowledgement and worker-time token minting. Agent investigation no longer calls GitHub tools; rate-limit policy applies to server-owned Octokit used for metadata, publish, and workspace prepare.

## Context

Large PR reviews drive many GitHub REST calls in a single **review run** (pg-boss worker job). Production observed sustained `Bad credentials` errors during bursts; root cause was not proven, but the failure mode matches rate-limit / secondary-limit pressure.

`@octokit/plugin-retry` alone does not pace requests or honor `Retry-After` for secondary limits.

## Decision

1. **Global throttling** — Compose `@octokit/plugin-throttling` with `@octokit/plugin-retry` on every `installationOctokit()` instance (publish, PR-surface I/O, file listing). Plugin order: `retry`, then `throttling` (throttling outermost).

2. **Hook policy** (`src/github/octokitThrottle.ts`)
   - `onRateLimit`: retry when `retryCount < PRIMARY_RATE_LIMIT_MAX_RETRIES` (2).
   - `onSecondaryRateLimit`: retry when `retryAfter > 0` and `retryCount < SECONDARY_RATE_LIMIT_MAX_RETRIES` (3).

3. **Structured logging** — Throttle hooks log `octokit_on_rate_limit` / `octokit_on_secondary_rate_limit` with method, URL, `retryAfter`, and `retryCount`. Circuit open logs `github_rate_limit_circuit_opened`. Never log tokens.

4. **Circuit breaker** — After 3 consecutive classified rate-limit failures in one review or ask run, short-circuit nonessential GitHub API tools for the remainder of the run. Publish/submit tools in `ESSENTIAL_GITHUB_TOOL_NAMES` stay available.

5. **`listPullRequestFiles`** — Server-side pagination (`per_page: 100`), caps `MAX_PR_FILES_LISTED` (default 300) and `MAX_PR_FILES_PATCH_BYTES` (default 500_000).

## Consequences

- Reviews on large PRs may run longer (throttle waits); ADR 0009 moves review execution out of the webhook request fiber.
- Truncated PRs (>300 files) degrade review coverage by design.
- Throttle state is per-process; `REVIEW_CONCURRENCY > 1` or multi-replica deploys can still burst the same installation.
- Effective GitHub load scales roughly as `replicas × localConcurrency` per queue (see [operations.md](../operations.md)).
- **MVP shared circuit:** opening a local rate-limit circuit also upserts Postgres `github_installation_rate_limit_circuits` (`installation_id`, `open_until`, `last_error_kind`). Other workers check that row before starting review/ask runs and hydrate their local circuit open so they do not immediately re-amplify 403/429 on the same installation.

## Superseded by ADR 0009

- Async webhook ack (early `200`).
- Mid-review installation token re-mint.

## Deferred

- Full Redis Bottleneck clustering (still optional). MVP: Postgres shared circuit above.
