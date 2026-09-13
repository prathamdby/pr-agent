# ADR 0035 — Head CI state and projection

## Status

Accepted. Supersedes [ADR 0018](0018-llm-authored-ci-summary.md) decisions 5 and 6. Amends [ADR 0004](0004-github-api-rate-limits.md) (projector honors the shared rate-limit circuit) and [ADR 0034](0034-escalated-retries.md) decision 7 (the projector is an unleased `closeOwnVerdict` caller). Runbook: [docs/agent-work-ops.md](../agent-work-ops.md).

## Context

ADR 0018 put CI authoring at publish time and patched later cells from a `workflow_run` / `check_suite` refresh job. Publish waited and polled GitHub. Refresh edited the comment with HTML markers. Mixed writers raced. A leftover refresh lane existed so old web instances could keep sending while the projector landed.

Facts are commit-scoped. Two pull requests that share a head share checks. The installation's own verdict is per work item and is not a fact.

Webhook delivery is best effort. A head whose checks finished before the App saw the pull request would stay "Waiting for CI" unless one path may seed from GitHub.

## Decision

1. **One durable row.** `pr_head_ci_state` is keyed `(owner, repo, head_sha)`. `check_run` and `status` deliveries write named checks under a newer-observation rule in the same transaction as `webhook_events`. `classifySnapshot` derives `rollup`. `version` increments only when a write is accepted.

2. **One later writer.** `ci-projection` is the only job that renders CI cells after claim time. Ack, ticks, and publish read the row at claim time, stamp `v=<version>` on the marker, and re-enqueue if the version moved after the GitHub write or if the row is missing or `seeded_at` is null. The projector patches when marker `head` matches and marker `v` is older. It re-reads the body immediately before the write and re-enqueues if `progress-revision` moved. Lost updates converge by that version re-check. No writer copies a previous body's CI row. No advisory lock is held across HTTP.

3. **One seed.** When the row is missing or `seeded_at` is null, the projector takes one `getCiStatus` read, writes it with `seeded_at`, and continues. A failed first snapshot after `storePrNumbersForHead` inserts an empty row still seeds on the next job. No other path reads CI from GitHub.

4. **One own-verdict writer.** Terminal `PR Agent Review` and optional `pr-agent/review` writes go through `closeOwnVerdict`. Live executions fence on the lease epoch. The projector and sweeper pass `leaseEpoch: null` and write only after `agent_work_items.status` is terminal. A started `check_run` publish row stays open while `detail.status` is `in_progress` or `detail.conclusion` is missing. Failed reviews close as crashed. A completed review with a `summary_comment` record closes as published or partial from that record. A completed review without a summary closes as unpublished. The sweeper retries that close for terminal reviews, not only `running` rows.

5. **Completed-run intake is head-scoped.** `workflow_run` and `check_suite` completed deliveries enqueue one debounced `ci-projection` for the head. They do not write facts. Empty `pull_requests[]` still enqueues. `pull_request` `opened`, `synchronize`, and `reopened` enqueue the same job when the row is missing or `seeded_at` is null, including when no review work is planned. Each projection merges stored `pr_numbers` with `agent_work_items` and one `commits/{sha}/pulls` lookup.

6. **Authoring lives on the projector.** A failing rollup runs one LLM turn per facts hash. The result is stored on `authored` and does not bump `version`. Publish does not wait or poll.

7. **Shared-circuit deferral.** Before any GitHub read or write, the projector reads `github_installation_rate_limit_circuits`. If the circuit is open, it re-enqueues with `startAfter = open_until` and exits. That is the only REST gate for projection. The in-process circuit still short-circuits agent tools only.

8. **Retired refresh lane.** `agent-work-ci-refresh` and `agent-work-ci-refresh-dead` are not live queues. Boot deletes both after a drain check (no queued, active, or deferred jobs). In-flight leftovers expire if the drain check refuses.

## Consequences

- Web and worker no longer share a mixed-version refresh shim.
- A comment's CI row updates from durable facts, not from a surgical regex edit of the last body.
- A required own check reaches a terminal conclusion after cancel, supersede, stale head, crash, and retry exhaustion.
- Operators still need Checks read on every install and Actions read for rich failure explanations.

## Reversal

Restore a publish-time GitHub snapshot and a comment-body refresh job. That reintroduces polling, mixed writers, and a second queue lane.
