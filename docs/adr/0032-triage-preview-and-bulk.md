# ADR 0032 — Triage preview then bulk apply

## Status

Accepted.

## Context

`/triage` applies eligible findings immediately: conversation scope is the full
inventory, thread scope is one finding. Authors asked for a would-be diff
before a bulk apply, plus a way to drop individual threads from that set.
Eligibility rules stay unchanged. There is no silent preference learning and no
cross-PR bulk.

## Decision

1. **Same work type, three modes.** `TriageWorkPayload.mode` is `"apply" | "preview" | "bulk"`. Missing `mode` on stored rows is `"apply"`. No new `WorkType`.

2. **Parse at the slash boundary.** `parseTriageCommand` reads the first non-empty line: `/triage` is apply, `/triage preview` is preview, `/triage all` (optional `exclude <ids>`) is bulk with `scope: "all"`. Unknown subcommands and invalid exclude lists ack a refusal and do not create a work item.

3. **Preview records a publish step, not a branch mutation.** Preview reuses the triage checkout, agent, and `commitFix` path so stacked per-finding diffs match apply. Local commits die with the ephemeral checkout. The worker never calls `checkout.push()` or `publishTriage`. It upserts `## PR Agent Triage Preview` and records `triage_preview` with `{ headSha, threadRootCommentIds, hunks, payload }`. Unique `(resource_key, review_lens, step)` means one preview row per PR; a later preview updates it.

4. **Bulk requires that preview and replays it.** Before checkout, load the latest completed `triage_preview` for the resource key. Missing, unparseable, or `detail.headSha !==` current head is `publishTriageReportOnly` and completed, with no writable checkout. The approved set is `preview.threadRootCommentIds ∩ current inventory − excludeThreadRootCommentIds`. Bulk applies only stored hunks that were displayed (non-empty diff). It does not start a second agent run. Then the existing `publishTriage` road (push-or-nothing, fast-forward, thread actions, report).

5. **Partial outcomes stay on the apply road.** Applied is `fixed` and pushed. Skipped covers skipped / already-resolved / dismissed / excluded / not in preview. Failed is a `commitFix` error or a `fixed` verdict with no commit. Applied plus failed is Partial (`degraded: true`). Failed findings do not block push of applied commits.

## Consequences

- `/triage` without a subcommand is unchanged apply mode.
- Authors must preview on the current head before `/triage all`.
- `publish_records` gains `triage_preview` (migration `028_triage_preview_step.sql`).
- Preference learning stays explicit: maintainers still commit `.pr-agent/*.mdc` suggestions themselves.

## Reversal

Drop `mode` / exclude fields, the `triage_preview` step, and the preview/bulk parse branches. Existing `/triage` apply continues to work.
