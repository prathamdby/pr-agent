# ADR 0035 — Head CI state and projection

## Status

Accepted. Supersedes [ADR 0018](0018-llm-authored-ci-summary.md) decisions 5 and 6. Amends [ADR 0004](0004-github-api-rate-limits.md) (projector honors the shared rate-limit circuit) and [ADR 0034](0034-escalated-retries.md) decision 7 (the projector is an unleased `closeOwnVerdict` caller). Runbook: [docs/agent-work-ops.md](../agent-work-ops.md).

## Context

ADR 0018 put CI authoring at publish time and patched later cells from a `workflow_run` / `check_suite` refresh job. Publish waited and polled GitHub. Refresh edited the comment with HTML markers. Mixed writers raced. A leftover refresh lane existed so old web instances could keep sending while the projector landed.

Facts are commit-scoped. Two pull requests that share a head share checks. The installation's own verdict is per work item and is not a fact.

Webhook delivery is best effort. A head whose checks finished before the App saw the pull request would stay "Waiting for CI" unless one path may seed from GitHub.

## Decision

1. **One durable row.** `pr_head_ci_state` is keyed `(owner, repo, head_sha)`. `check_run` and `status` deliveries write named checks under a newer-observation rule in the same transaction as `webhook_events`. `classifySnapshot` derives `rollup`. `version` is the monotonic revision of everything that affects rendered CI projection. It advances when a CI fact is accepted, when `seeded_at` first becomes set (even for an empty or already-known snapshot), or when a verification-failure signal effectively changes between missing/inactive and active or changes head. Duplicate facts, repeated seed, duplicate verification state, and authored-cache writes do not bump it.

2. **One later writer.** `ci-projection` is the only job that renders CI cells after claim time. Ack, ticks, and publish read the row at claim time, stamp `v=<version>` and `fmt=<current>` on the marker, and re-enqueue when the head still needs a seed or the row version moved after the GitHub write. The projector patches when marker `head` matches and either marker `v` is older or the marker format is older at equal `v`. Completed reviews also sync the action-line CI phrase in the same body edit. It re-reads the body immediately before the write and re-enqueues if `progress-revision` moved. Lost updates converge by that version re-check. No writer copies a previous body's CI row. No advisory lock is held across HTTP. Per-PR results are `current`, `updated`, `retry`, or `irrelevant`.

3. **One seed.** When the row is missing or `seeded_at` is null, claim-time render and the visible gate show Waiting for CI. The projector takes one `getCiStatus` read, writes it with `seeded_at`, always advances `version` once on that transition, and continues. A complete empty snapshot is `none` / "No CI checks on this head" (action line: "No CI checks ran on this head"). An incomplete empty listing stays unavailable. A failed first snapshot after `storePrNumbersForHead` inserts an empty row still seeds on the next job. No other path reads CI from GitHub.

4. **One own-verdict writer.** Terminal `PR Agent Review` and optional `pr-agent/review` writes go through `closeOwnVerdict`. Live executions fence on the lease epoch. The projector and sweeper pass `leaseEpoch: null` and write only after `agent_work_items.status` is terminal. A started `check_run` publish row stays open while `detail.status` is `in_progress` or `detail.conclusion` is missing. Failed reviews close as crashed. A completed review with a `summary_comment` record closes as published or partial from that record. A completed review without a summary closes as unpublished. The sweeper retries that close for terminal reviews, not only `running` rows.

5. **Completed-run intake is head-scoped.** `workflow_run` and `check_suite` completed deliveries enqueue one debounced `ci-projection` for the head. They do not write facts. Empty `pull_requests[]` still enqueues. Each projection merges stored `pr_numbers` with `agent_work_items` and one `commits/{sha}/pulls` lookup.

6. **First seed from pull_request.** `opened`, `synchronize`, and `reopened` enqueue that same job only when the row is missing or `seeded_at` is null. A delivery that plans no review work records `ci_projection_enqueued` when it schedules that seed, and `ignored_pull_request_${action}` when it does not. Completed-run intake still always enqueues.

7. **Authoring lives on the projector.** A failing rollup runs one LLM turn per facts hash. The result is stored on `authored` and does not bump `version`. Publish does not wait or poll.

8. **Shared-circuit deferral.** Before any GitHub read or write, the projector reads `github_installation_rate_limit_circuits`. If the circuit is open, it re-enqueues with `startAfter = open_until` and exits. That is the only REST gate for projection. The in-process circuit still short-circuits agent tools only.

9. **Retired refresh lane.** `agent-work-ci-refresh` and `agent-work-ci-refresh-dead` are not live queues. Boot deletes both after a drain check (no queued, active, or deferred jobs). In-flight leftovers expire if the drain check refuses.

10. **Verification failure is a projection input.** Activate and clear write `publish_records` step `verification_failure`, advance the head revision only on an effective transition, and enqueue projection in the same transaction. The projector injects or omits the failure block from the durable signal; it does not preserve an old block from a previous body. Shared heads keep one revision; each PR reevaluates its own verification record.

11. **One-time legacy repair.** Migration `031` adds `projection_repair_pending` (existing rows true, new rows false). The worker diagnostics tick enqueues ordinary projection jobs for a bounded pending batch. The projector clears the flag only after every resolved PR is `current` or `updated`. Transient GitHub failures leave it pending and re-enqueue. Heads with no associated work are logged as unreachable and cleared; retention owns deletion. Roll out one worker/web build; do not mix projector versions. Rollback may leave the additive column and attrs in place.

## Consequences

- Web and worker no longer share a mixed-version refresh shim.
- A comment's CI row updates from durable facts, not from a surgical regex edit of the last body.
- Seeded empty heads show terminal no-CI copy instead of Waiting forever.
- A required own check reaches a terminal conclusion after cancel, supersede, stale head, crash, and retry exhaustion.
- Operators still need Checks read on every install and Actions read for rich failure explanations.

## Reversal

Restore a publish-time GitHub snapshot and a comment-body refresh job. That reintroduces polling, mixed writers, and a second queue lane.
