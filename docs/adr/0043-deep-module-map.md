# ADR 0043: Deep module map

## Status

Approved for M0–M18 execution. M0 establishes the compatibility evidence before
implementation; the milestone amendments below are approved.

## Context

Durable intake, execution, publication, and recovery have ordering contracts that
callers must currently assemble. Moving those contracts is safe only when their
persisted identities, lease predicates, trusted context, and model-visible bytes
remain unchanged.

## Decision

Deep modules own ordering behind small interfaces. Delete a module only when it
has no current caller or product reason. Keep a module when removing its interface
would expose meaningful policy or complexity. A module that makes callers repeat
its ordering needs a deepen verdict before the next milestone.

The implementation order is M0, M1, M2, M3, M5, M4, M6, M7, M8, M9, M10, M11,
M12, M13, M14, M15, M16, M17, M18. Each milestone runs the backend gate, the
dedicated-database integration suite, disposable-stack verification, and a
byte-for-byte prompt dump comparison before staged deslop and a scoped commit.
One pull request targets `main`; no migration or runtime change is authorized
by this document alone.

Persisted operation keys, child mutation hashes, publish steps, hidden comment
markers, queue names, log events, and analytics properties keep their existing
bytes while readers exist. ADR 0025's system and tool prefixes remain unchanged.
The golden compatibility cases live in the existing
`test/integration/publishRecordBatches.integration.test.ts`; prompt inspection
uses `nub run dump-prompt all`.

## M0 failure modes

Write these before changing the tests or implementation:

1. Renaming an operation key or changing its input hashing remutates an accepted
   GitHub write on replay.
2. Dropping a parent operation frame makes nested mutations collide or escape
   the parent's recovery lookup.
3. Changing a hidden marker leaves an existing comment or mutation unreadable.
4. Renaming a publish step or lens loses completion evidence or changes its
   uniqueness scope.
5. Changing queue identities strands retained jobs.
6. Changing telemetry names or property values breaks existing consumers.
7. A prompt dump omits a role, optional tool, or generated tool catalogue and
   falsely claims stable provider prefixes.
8. A dump contains timestamps, credentials, paths, or nondeterministic identifiers
   and cannot support a reproducible comparison.
9. A shallow module is retained without a caller, or a useful invariant owner is
   deleted because only its file size was considered.
10. The dump script is excluded from typechecking and silently keeps a stale
    execution-outcome shape. Typecheck the script; the judgment renderer accepts
    report data, not execution status, without changing rendered bytes.

## Deletion verdicts

No deletion candidates. Four modules keep useful boundaries. Three require
deepening, not removal:

| Module               | Verdict | Current caller and owned or leaked contract                                                                                                                                                                                               |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `askQuota`           | Deepen  | `intake/askIntake.ts::applyAskIntake` must reserve quota, insert work, and compensate an insertion conflict in one transaction. Bucket ordering and execution-receipt accounting already belong to `askQuota`.                            |
| `prHeadCiState`      | Keep    | Intake and CI projection use its locked newer-observation merge, idempotent seed, and material-change revision writers. `publishVerificationFailure.ts::writeVerificationSignal` already owns atomic signal/revision/enqueue composition. |
| `publishTriage`      | Deepen  | `triageExecutor.ts` parses a stored push, fabricates a checkout, and supplies `priorPush` to avoid pushing again. The publisher already owns intent recovery, push-before-thread-resolution, and report publication.                      |
| `triageExecutor`     | Deepen  | Fresh and bulk paths separately install commit/push guards. Preview independently refuses push. Recovery and attempt admission must retain their existing order behind one triage execution boundary.                                     |
| `agentEventSink`     | Keep    | `createFeatureSession.ts` uses its lifecycle-to-event/span projection and shared database/analytics fan-out.                                                                                                                              |
| `lifecycleSanitizer` | Keep    | `piSessionImpl.ts` wraps the sink with its forbidden-field, role, phase, and event-kind policy. It is a security boundary, not a pass-through.                                                                                            |
| `localPrWorkspace`   | Keep    | `prRepositoryView.ts` uses its pinned-head preparation, credential removal, symlink removal, read-only tree, bounded search, and failure cleanup. M7 may narrow its returned reader interface without deleting its lifecycle owner.       |

### Approved milestone amendments

Approved before M1:

- **M11, atomic ask admission:** keep retained-mention resolution before quota
  admission. Make admission, work insertion, and insertion-conflict compensation
  one operation on the delivery transaction. Queue writes remain transactional.
  Keep terminal reservation release in the existing database trigger.
- **M8/M13, triage publication recovery:** the publication boundary selects,
  parses, and validates stored push evidence before recovery-only publication.
  Do not pass a fabricated checkout or an independently supplied `priorPush`
  from feature orchestration. Preserve stored bytes, intents, and epochs.
- **M7/M13, triage write policy:** one triage execution boundary selects preview,
  apply, or bulk capabilities and installs cancellation/closed-PR mutation
  guards. Preview cannot push. Recovery precedes fresh-attempt admission.

Failure modes for these additions, before tests or code: a reservation without
matching work; conflict compensation outside the delivery transaction; mismatched
stored head or inventory skipping a required push; a fresh branch missing a
commit/push guard; preview acquiring push authority; recovery spending an attempt.
The existing ask-intake, triage executor/publication, and durable integration
suites remain their owner tests. No new test files are proposed.

The golden child table also records that `publishDescription` hashes its complete
runtime argument, including configuration fields beyond its declared `Pick`.
M16/M17 must preserve retained mutation identities when narrowing that argument
or replacing the method. Renaming a TypeScript method is not permission to rename
the wire mutation kind or the recovery lookup for existing intents.

## M1 failure modes

Recorded before test or production changes:

1. Removing a barrel leaves a runtime import or a mock aimed at a dead module.
2. Inlining description publication changes the complete configuration argument
   and therefore the retained child mutation hash.
3. Moving execution halts changes error codes, cross-worker encoding, or prompt
   and tool bytes.
4. Required surface reads silently disappear from a fake or fixture, weakening
   recovery, bot ownership, or check lookup.
5. Pull-request title/body casts hide a missing field in a fake or provider read.
6. Inlined helpers change authorization, file URLs, telemetry fields, placement
   order, CI copy, or token-expiry boundaries.
7. Removing a settings file duplicates a value, drops a consumer, or changes an
   import boundary. Only proven single-owner settings may move.
8. Replacing duplicate resource types changes serialized payloads rather than
   only their TypeScript representation.

M1 implementation and the full milestone gate are complete. Deslop and commit
remain pending.
Existing owner tests replace direct imports of deleted private helpers. No new
test files or helpers were created. `PullRequestForFileList` now carries title
and body, and the three recovery reads on `PrSurface` are required.

Single-owner settings evidence: every production consumer of `slashConstants.ts`
was `intake/slashIntake.ts`; both exports of `migrationConstants.ts` were used
only by `db/migrations.ts`. Their constants now live privately in those owners.
Shared constants remain in settings. Catalog/path modules retain parsing and
path-resolution policy; they are not settings-only deletion candidates.
`firstNonEmptyLine` has two production parsers, so slash parsing owns its one
implementation and ask parsing imports it there. The CI action formatter also
has two consumers, so it joins the existing CI cell renderer rather than being
duplicated into callers.

Local evidence: formatting, typecheck, backend lint, and guards passed. The final
narrow existing-owner run passed 555 tests across 33 files, including architecture,
import-boundary, and generated feature-map checks. The complete published `/help`
reply remains pinned in the intake owner test rather than separate assertions
against private constants. Prompt comparison is byte-identical to M0, SHA-256
`d29f822bfaeba33e5526fd5aa3b618f22eaaf691e9e11052b67a9e1778ae06e5`.
Unsafe source assertions fell from 90 to 87; the baseline shrinks to 87.
The initial `nub run test -- <paths>` invocation did not forward its filters and
hit the 120-second limit during a broader run; it is not recorded as a pass.
The parent's full gate passed 196 unit suites (2,644 tests), 14 dedicated
database integration suites (499 tests), and disposable-stack verification
(499 tests). The complete prompt dump remained byte-identical. Verification
left `verify-artifacts/2026-10-02T14-03-02-279Z.md`.

## Consequences

No new test files or main-site copy changes. Existing invariant owner tests stay
at their strongest boundary. Baselines may only shrink. Web and worker keep the
same persisted payloads and deploy together when internal contracts move.

ADR 0023 decision 6 remains in force until M5 proves that the checkpoint and
resume-snapshot tables have no readers outside the deleted subsystem. M5 will
record that proof and amend the decision in the same commit as migration 036.
