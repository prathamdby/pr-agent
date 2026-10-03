# ADR 0044: Review-specific validated artifact recovery

## Status

Approved for the review-reliability PR. Recovery remains default off pending
local durable integration and process-crash/restart proof and rollout approval.
Amends [ADR 0020](0020-orchestrated-review.md),
[ADR 0023](0023-pi-native-agent-runtime.md),
[ADR 0024](0024-workspace-primary-grounding-and-evidence.md), and
[ADR 0034](0034-escalated-retries.md). It does not reverse migration 036 or
restore the unused session subsystem removed under
[ADR 0043](0043-deep-module-map.md).

## Context

A restarted review can lose validated specialist computation while accepted
GitHub operations remain durable. Restoring a transcript would expand the
content store and mix old authority with current policy. Reusing saved coverage
without reading the workspace would turn a cache into publish authority.
The recovery boundary must preserve exact accepted mutations while rebuilding
only the validated review state needed to continue safely.

## Decision

### Review artifacts, not sessions

`REVIEW_RECOVERY_ENABLED` is a strict boolean, default `false`, mapped to
`cfg.review.recoveryEnabled`. It is not a new feature mode. Additive migration
`037_review_run_artifacts.sql` creates `review_run_artifacts`, keyed by work item
and logical artifact key. `src/review/recovery/reviewArtifacts.ts` owns schemas,
versioning, redaction, stable encoding, binding, and hashes.
`src/agentWork/reviewArtifactRepository.ts` owns persistence.

Retain only validated, redacted structured briefs and reports, ordered prepared
and settled publication decisions, and final-summary input or reference.
Reports include reproducible evidence descriptors. Prepared decisions retain
the canonical publication input and full ledger delta needed for reconstruction,
including summary-only decisions and footers. Settlement is a bounded local
observation referencing its prepared decision, never remote acceptance authority.
Dependencies bind to earlier artifacts by logical key and payload hash; a later
decision cannot precede settlement of the previous decision.

No raw checkout files, prompts, reasoning, transcripts, or generic checkpoints
are retained. Structured finding detail, fix directions, and suggested code may
contain code excerpts. Redaction happens before storage and the redacted result
must still validate. These private artifacts are not metadata-only agent events
and must never be sent as PostHog properties.

### Identity and compatibility

Bind schema and review-contract versions, installation/tenant, work item,
resource, owner/repository/PR, reviewed head and base, and a fingerprint of
effective inputs, policy, settings, and model selection. A schema-only change
is not the only reason to bump the contract version: evidence, judgment, and
publication-gate changes also require compatibility review.

Identity, hash, dependency, or version mismatch is a cache miss, not authority to
reuse partial state. The consumer computes the current effective-input digest;
the store does not retain those raw inputs. A model change from retry escalation
can invalidate computation. An accepted remote operation receipt remains
authoritative even when every artifact is a miss. Never reopen accepted intents
to make a new cache entry fit.

The input digest includes stable effective publication capabilities for this
run, including category-label applicability. It excludes grant observation
timestamps, generations, token values, and credentials. A changed grant may
invalidate reusable computation; it cannot invalidate an exact accepted receipt.

### Fenced and bounded persistence

Writes lock the exact live PR actor lease first, then read and lock the active
review row in a separate statement. Require running, uncancelled review work,
matching identity, and numeric execution epoch. No write follows a newer epoch.
Identical logical key and bytes are idempotent; incompatible retained versions
disable caching, and conflicting compatible content is an explicit error.

The item lock serializes the aggregate 1,048,576-byte (1 MiB) UTF-8 budget across
all artifacts. Each prepared decision reserves 8,192 bytes (8 KiB) for settlement.
Settlement atomically replaces that reservation with bounded metadata. Large
ledger decisions belong in the prepared artifact, not in the settlement record.
Capacity or incompatible results disable new caching without changing the
normal review path; already prepared plans still settle. Actual storage errors
propagate to the existing durable retry policy. Lease loss stops execution.

The work-item foreign key cascades retention unconditionally, even with recovery
off. `AGENT_WORK_RETENTION_SECONDS` bounds terminal work and its artifacts.
Disabling scheduled retention leaves them retained. No separate retention lane
or external service is introduced.

### Rebuild authority from current reads

Saved coverage is never restored as evidence. Before a cached report can be
used, `evidenceLedger.ts::revalidateEvidenceDescriptors` reads the exact ranges
through the current governed workspace reader at the bound head. Hash complete
lines normalized to LF without a terminal newline. Refused, incomplete, clamped,
head-mismatched, or hash-mismatched reads are misses. Reader outages propagate.
Grant coverage only after all descriptors pass. Normal report validation,
checkout coverage, repository-policy trust, live-head, cancellation, lease, and
publish gates still apply.

Start a fresh judgment session from normal trusted context, an untrusted brief,
the reconstructed canonical ledger, and remaining validated reports. Do not
restore an old transcript, guest state, or system instructions from artifacts.
No saved report can directly authorize a finding.

### Publication and attempt accounting

Prepared plans precede delegation; settle them from exact operation intent and
completion evidence before moving to later decisions. Preserve existing wire
mutation keys, complete-input hashes, publish steps, and hidden remote markers.
`outcome_unknown` stays fail-closed. A local settled observation is not proof
that GitHub accepted a mutation; missing receipts never authorize replay.

Resumed workspace preparation, evidence rereads, read-tool work, and model work
must charge the runner's memoized admitted `beginAttempt`. Lifecycle claims and
receipt-only reconciliation are budget-neutral. At the cap, only receipt-only
reconciliation can proceed; no new workspace or model work is admitted.
pg-boss remains the scheduler. Deadlines, retry limits, and escalation are not
redesigned.

Fresh installation grants and managed authentication are prepared before real
head/identity checks. Saved completion acceptance is reconciled before selecting
new verdict writes or enforcing access to create new output. Receipt-only
completion stays possible at the attempt cap after publication is revoked.
Confirmed denial or unknown availability can defer optional cleanup without
invalidating proven completion. New work alone requires essential access.
Access-check retries have their own lease-fenced durable counter, bounded by
`QUEUE_RETRY_LIMIT + 1`, reset by a successful preflight, without model attempts
or escalation. Shared-circuit deferral spends no probe count.

### Related reliability boundaries

Structured failure origin and lifecycle decisions outrank ambiguous error text.
A typed `github.review_thread_resolution_denied` proves nonacceptance of the
resolution child only. It cannot undo an accepted stub reply or prove parent
workflow nonacceptance. Verification completion requires a receipt for the
exact work item, operation key, head, verdict, and required stub/resolution
outcomes, not resource-scoped history.

Local audit and PostHog are independent. Runtime session/send UUIDs differ from
reusable prompt-cache IDs; unreported usage is omitted. Specialist non-generation
stages emit immediately as they settle. A durable terminal event requires a
winning committed terminal write; an execution stop alone is nonterminal.
No historical telemetry is backfilled.

## Rollout and reversal

Install migration 037 first, then coordinate matching web and worker telemetry
and recovery changes. Keep recovery off until local durable integration and
process-crash/restart proof and rollout approval. Live GitHub permission/mutation
checks are waived for this PR, not the local proof. Local denial fixtures do not
prove a live permission cause.

Disable recovery for rollback and retain rows, work, leases, intents, publish
records, and receipts. Do not drop the table, reset accepted intents, or reopen
terminal work. Pause active and queued verification execution before downgrading
so old code cannot misinterpret the new terminal denial. A feature flag alone
does not stop retained queued execution. See
[operations](../operations.md#review-reliability-rollout) and the
[queue runbook](../agent-work-ops.md#validated-review-artifact-recovery).

The installation capability amendment also requires additive migration `038`
before the matching worker build. Upgrade affected workers together. Rollback
stops or drains those workers, restores the prior build, and retains capability
tables, preflight counts, verdict selections, intents, and receipts. The old build
restores the previous permission-denial behavior; it does not retain the new
access gates or scoped degradation safeguards.
