# Plan 005 investigation

Question: Can pg-boss redeliver an agent-work job while the original handler is still executing, and does `claimWorkForExecution` admit a second executor?

Evidence:

- `src/settings/defaults.ts:26-27` sets `DEFAULT_QUEUE_EXPIRE_IN_SECONDS = 3600` and `DEFAULT_QUEUE_HEARTBEAT_SECONDS = 60`.
- `src/agentWork/boss.ts:18-28` applies those values to every queue through `queueDefaults`.
- `node_modules/pg-boss/dist/types.d.ts:127-131` documents heartbeat as a liveness check. Missing heartbeat fails or retries the job.
- `node_modules/pg-boss/dist/types.d.ts:307-311` documents worker heartbeat refresh timing as `heartbeatSeconds / 2` by default.
- `node_modules/pg-boss/dist/manager.js:187-208` starts a timer that calls `touch()` for active jobs while the handler promise is pending.
- `node_modules/pg-boss/dist/manager.js:210-217` races the handler against `expireInSeconds` and fails the pg-boss job on timeout.
- `node_modules/pg-boss/dist/tools.js:33-43` implements that timeout with `Promise.race`; it aborts the signal after the race but does not cancel a handler that ignores the signal.
- `node_modules/pg-boss/dist/plans.js:1001-1006` still has a hard active-job timeout based on `started_on + expire_seconds`.
- `node_modules/pg-boss/dist/plans.js:1008-1024` separately fails jobs whose heartbeat is stale and updates only `heartbeat_on` during `touch()`.
- `node_modules/pg-boss/dist/plans.js:1029-1104` re-inserts failed active jobs as `retry` until `retry_count` reaches `retry_limit`, preserving the job id.
- `node_modules/pg-boss/dist/plans.js:748-857` fetches retry jobs again and marks them `active`.
- `src/agentWork/repository.ts:98-120` returns `true` for an already-`running` work item with no cancellation request.
- `src/agentWork/durableJob.ts:232-237` claims the app-level row before loading the payload, but the pg-boss abort signal is not part of the durable execution context.

Verdict: BUG

Heartbeat protects against stale workers, but it does not extend `expireInSeconds`. A handler that runs past 3600 seconds is timed out by pg-boss and retried. Because this repo does not thread pg-boss's abort signal through durable execution, the original handler can keep running if the provider or publish path ignores cancellation. The retry then reaches `claimWorkForExecution`, sees the app row still `running`, and returns `true` through the resume path. That admits two concurrent executors for one work item.

Reachability:

Review work can plausibly exceed one hour on large PRs, slow providers, or long publish retries. The queue retry delay defaults to 30 seconds, so overlap can start shortly after the timeout if the original handler remains alive.

Recommended follow-up:

Keep the new concurrent double-claim test as the current-contract pin. A follow-up fix should add an app-level lease, for example `locked_until`, or reject resume while `started_at` is fresh. After the fix, change the double-claim test to assert exclusive ownership.
