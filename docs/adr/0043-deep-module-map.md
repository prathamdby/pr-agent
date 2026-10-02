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

## M2 failure modes

Recorded before existing-test or production changes:

1. Separate progress and verdict admission registries retain more than half the
   pool and starve nested lease checks. Both lanes must share one pool registry.
2. Admission contention performs a verdict read without a client, or SQL lock
   contention loses the existing read on its attempted client.
3. A contender retains a client during bounded backoff, or a failed checkout
   leaks admission capacity.
4. A false unlock returns an unsafe session to the pool. Unlock and release
   failures must not replace the original application or provider error.
5. Lock key bytes change and old and new workers stop serializing.
6. The max-one unleased verdict exception disappears, or leased verdict and
   progress lose their distinct capacity errors and missing-max defaults.
7. Shared fencing adds checks to SQL-only state writes, removes zero-row
   rechecks, or adds them to intent merges or verdict enrichment.
8. Moving fencing changes SQL aliases, parameter positions, CAS predicates,
   terminal exceptions, or lease expiry semantics. SQL stays verbatim.
9. Rescheduled parent completion or the running cancellation fallback escapes
   the shared write sequencing.
10. Moving surface tests drops mutation identity, recovery, cancellation,
    stolen-lease, or unknown-outcome coverage. The existing integration owner
    retains all nine cases and exercises real lease state where applicable.

M2 implementation moves both retained-session loops into
`src/db/sessionLock.ts`. One registry limits combined progress/verdict holders
to half the pool, with the existing unleased one-slot verdict exception. The
primitive accepts typed `SessionLockKey` families, encodes their existing bytes,
and owns all admission math and missing-max defaults. Callers cannot supply
capacity. The adapters retain capacity errors, progress unlock logging, and
contention behavior. Safe release needs no caller flag. This changes only internal deferral timing. False unlock
destroys the session; application/provider errors retain precedence.

`src/agentWork/fencedWrite.ts::fencedWrite` owns numeric-epoch check sequencing for all
19 writers and 20 SQL calls, including rescheduled parent completion and the
running cancellation fallback. Repository SQL stays with its owner. The 35
work-state and five intent template literals are byte-identical to M1. Of the
30 publish-record template literals, 29 stay byte-identical in that repository;
the own-verdict lock key moved into the typed codec with identical encoded bytes.
All SQL literals remain unchanged. SQL-only, precheck-only, and zero-row-recheck
call patterns stay distinct.

All nine surface fence/identity/recovery cases moved into the existing PR actor
lease integration suite; the first three now use real lease or cancellation
state. The old unit file is deleted. Existing summary-coordination coverage also
proves odd-pool cross-lane admission, bounded waiting without checkout,
release before backoff, and false-unlock disposal. The stronger typed-key test
failed before the interface change and passed afterward.
No new test file was created.

Local M2 checks passed: formatting, typecheck, lint, guards, and 107 tests across
seven existing unit suites. Source assertion count remains 87. The complete
prompt dump is byte-identical to M0, SHA-256
`d29f822bfaeba33e5526fd5aa3b618f22eaaf691e9e11052b67a9e1778ae06e5`.
The full milestone gate also passed: 195 unit suites (2,638 tests), dedicated
database integration and disposable-stack verification (508 tests each).
Verification left `verify-artifacts/2026-10-02T14-54-12-388Z.md`.

## M3 failure modes

Recorded before test or production changes:

1. A definition registers the wrong retained queue, work kind, lease policy, or
   head/context policy and strands jobs or widens execution authority.
2. A heterogeneous definition loses the connection between its loaded context
   and execution/terminal hooks.
3. Installation-only auth keys share credentials across App/private-key
   identities; rejected lookups remain cached or expired tokens remain usable.
4. Auth initialization moves the bot first-comment check behind another request
   or resolves a deferred head before the durable claim.
5. Injected runtime seams bypass production cancellation, lease fencing,
   admission, terminal callbacks, or rate-limit hydration.
6. Test reset branches survive in production caches, or isolated adapters still
   depend on a globally spied durable dispatcher.
7. An auxiliary caller loses its executor entry without receiving the same
   installation boundary and publication fences.
8. A repository view prepares before admission succeeds, or concurrent view
   requests spend two attempts. A rejected admission must remain rejected for
   the dispatch, and neither the view nor its callback may run.
9. Moving admission into the context skips review's lightweight admission or
   moves verification's bulk file/commit reads before admission. Recovery and
   empty verification must still complete without preparing a workspace.
10. A shared publish-abort policy misses the signal, durable cancellation, or
    stolen lease; it performs lease reads for unleased ask work; or a failed
    cancellation/lease read is treated as permission to publish. Review's
    additional live-head predicate remains review-owned.
11. Shared session metadata changes the work/installation/repository identity,
    adds a new snapshot-table dependency, or forces triage's writable checkout
    into the read-only repository-view lifecycle. Triage retains its checks
    before tool writes, commits, and pushes.

Existing executor, auth, worker, and durable integration tests own these
contracts. No new test files or helper files are introduced.

M3 implementation in the isolated runtime lane:

- `workDefinition.ts` supplies the closed, typed five-feature table used by
  worker registration through `DurableWorkDefinition`. Queue identities, lease policies, deferred-head resolution,
  review identity loading, and commenter-context policy remain unchanged.
- Execution builders expose their real execute/terminal hooks. Existing executor
  tests use those definitions and the production execution-context factory rather
  than globally replacing the durable runner. Existing integration dispatches
  use the same table and genuine runner.
- `installationSurface.ts` owns token/surface creation for durable, auxiliary,
  and code-index lanes, with credential-identity/installation isolation,
  near-expiry refresh, cold-lookup coalescing, and exact rejected-entry eviction.
  Auth/SDK caches expose production factories, not test reset exports.
  `openInstallationSurface(dependencies?)` returns the cache-owning adapter
  with `token(cfg, installationId)`, `botIdentity(cfg)`, and `create(pr)`.
  This deliberately differs from the proposed `openInstallationSurface(pr,
dependencies)`: a per-PR factory would discard the process-wide coalescing
  and token-freshness policy, and code-index builds need installation auth
  without a PR. `create(pr)` opens the concrete surface on that shared adapter.
- `createDurableRuntime` injects atomic transactions, renewal, observation, and
  installation adapters. `createDurableExecutionContext` owns memoized admission
  and live claim/escalation reads. `transactForTest` was in `durableJob.ts`, not
  an Effect service, and is removed there.
- The context now binds repository/installation/work identity and owns
  `withAdmittedRepositoryView`, `durability`, and `shouldAbortPublish`.
  Read-only executors cannot prepare their views before the same memoized
  admission used by lightweight review and verification's pre-bulk-fetch gate.
  Recovery and empty verification still avoid admission and checkout. Session
  metadata has no new snapshot/checkpoint imports or runtime fields.
  Description, review, verification, and triage adopt the shared signal,
  cancellation, then lease predicate. Review retains its live-head extension.
  Triage keeps its writable checkout and all existing tool/commit/push
  checkpoints, now also stopping on a stolen lease or aborted host signal.
  Verification's empty and late gates likewise stop on signal or lease loss.
  Failed shared reads propagate, never authorizing publication.

Main-checkout completion evidence: the four context-policy tests and triage's
stolen-lease write-guard test were added to existing suites before their
production changes and failed on the missing policies. The focused six-suite
run then passed 224 tests; the complete 21-suite focused M3 run passed 349.
`check:code`, guards, formatting, and exact M0 prompt comparison passed in main.
No new test files, helpers, aliases, golden edits, or baseline growth were
introduced. The final source assertion count stays 82.

Isolated evidence: 344 tests passed across 21 existing runtime, auth, GitHub seam,
architecture, and feature-map suites. Typecheck, backend lint, guards, formatting,
and exact M0 prompt comparison passed. Prompt SHA-256 remains
`d29f822bfaeba33e5526fd5aa3b618f22eaaf691e9e11052b67a9e1778ae06e5`.
Unsafe source assertions fell from 87 to 82. No services or provider calls were
started. The parent still owns the merged full gate, dedicated-database
integration, disposable-stack verification, deslop, and milestone commit.

## M5 failure modes

Write these before the owner tests and implementation:

1. A capped repair clears the last validation error without submitting, losing
   both the remaining repair rounds and the final diagnostic.
2. Sharing a loop changes submit prompts, registered tools, role budgets,
   checkpoint identities, cancellation checks, or description text selection.
3. An injected session bypasses role policy or lifecycle projection; disposal
   must still happen after success, cancellation, and send failure.
4. Dropping tables with a runtime reader outside the removed subsystem breaks
   recovery. Search `src`, `scripts`, and `docs` before deletion.
5. Removing unused snapshots accidentally removes agent events or authoritative
   operation intents, publish records, leases, and durable work recovery.
6. Removing configuration fields changes the full-argument description mutation
   hash pinned by M0. Preserve its current-reader argument shape intentionally.
7. SDK construction escapes the runtime boundary, or confinement breaks the
   legitimate prompt-dump tooling caller.
8. Retention, test hooks, or diagnostic queries continue referencing dropped
   tables. Existing migrations remain ordered; the current maximum is 035.
9. Reconstructing defaults misses a retained child that hashed non-default removed
   settings. Resolve its exact work item, parent frame, surface method, and
   operation marker before creating another intent. Never select only by method.
10. Ambiguous or malformed retained identities, missing markers, cancellation,
    or a lost lease must fail closed before mutation. Reusing a retained key must
    preserve unknown-outcome refusal and provider-proven failed retry semantics.

### M5 pre-deletion reader evidence

`rg -n 'agent_phase_checkpoints|agent_resume_snapshots' src scripts docs`
on detached `a8ed38d1` found SQL only in
`src/agentWork/phaseCheckpointRepository.ts` and
`src/agentWork/resumeSnapshotRepository.ts`, plus the snapshot diagnostic and
retention documentation in `docs/agent-work-ops.md`. No script reads either table.
Repository read APIs are called only by `runtime/sessionDurability.ts`.
`createFeatureSession.ts` invokes that subsystem during creation and after sends;
no feature updates its structured state. The remaining repository exports,
terminal cleanup, and retention are deletion/wiring, not recovery readers.
Agent events retain their own context and storage. Operation intents remain
authoritative and are not part of this deletion.

## M4 failure modes

Recorded before tests or production changes:

1. An executor reports completion before the durable completion mark wins,
   including a cancellation or supersession discovered by `completion_race`.
2. Moving capture duplicates completion events, emits them for replay/reschedule
   paths that were previously silent, or changes admitted failure/retry policy.
3. A closed outcome omits feature-specific fields, review profile measurements,
   CI degradation, or the existing analytics/log property values.
4. Review profiling measures runner completion/reactions instead of its existing
   executor interval, or loses profile logs on cancellation/supersession.
5. Telemetry failure after a successful completion mark reopens completed work
   or attempts terminal failure under a stale epoch.
6. Test assertions remain scattered across executor suites instead of checking
   actual post-transition dispatch in `durableJobAnalytics.test.ts`.

Existing owner tests gain regressions before code. No new test files, helper
files, schemas, queues, or provider capabilities are introduced.

### M4 outcome and evidence

`WorkCompletion` is a closed feature union with a review-profile variant and
no open extras field. The executors return values instead of capturing events.
The durable runner enriches CI and calls the single `recordWorkCompleted` owner
only after its completion or terminal-failure mark wins. Completion metadata
is optional so already-published recovery, empty verification, and reschedule
paths keep their existing silence. Capture errors are isolated from lifecycle
writes. Review metric logs and first profile-snapshot timing remain at their
original executor boundaries, including the lightweight snapshot before verdict
cleanup. The completed envelope and CI-degradation vocabulary are unchanged.

Before production changes, the existing analytics owner suite failed 16 cases,
including real description and lightweight-review definition dispatches that
captured before a losing/rejected completion mark, observed cancellation, or
verdict-cleanup failure. The migrated assertions cover feature scalars,
classified failures, CI degradation, and profile duration/counts without token
or generation dumps. Four executor suites no longer own analytics assertions;
the existing CI telemetry suite retains only its independent state-change case.

The integration golden table only changes its invocation to the closed input;
its expected persisted identities and analytics properties are unchanged. No
services, provider calls, commits, or main-worktree edits are part of this lane.
The focused gate passed 278 tests in 12 existing suites, typecheck, backend
lint, formatting, effect-version/dependency checks, guards, and diff checks.
The exact M0 prompt comparison stayed empty at SHA256
`d29f822bfaeba33e5526fd5aa3b618f22eaaf691e9e11052b67a9e1778ae06e5`.
Unsafe source assertions remain 78; no baseline changed.
The parent still owns merged full-gate, database-integration and disposable-stack
verification, deslop, and the milestone commit.

## M8 failure modes

Recorded before changing the existing owner tests or production code:

1. Moving parent frames changes a retained child key or input hash.
2. Shared and ask records lose their distinct uniqueness scopes; progress loses
   its independent owner gate, or inline batches overwrite retained evidence.
3. A recovered typed result is replaced by void ledger success, or an unknown
   mutation is retried without provider-proven nonacceptance.
4. Ask evidence adoption or verdict delegation bypasses the publication owner.
5. A stored triage push with a different head or inventory skips fresh work.
6. Recovery fabricates a checkout, accepts a partial push, or reconstructs
   intended commits from the remote branch instead of retained evidence.
7. Cancellation is observed after commit or push rather than before it.
8. Removing the memory setup drops crash/replay evidence rather than moving it
   to the existing database owner suite and an injected production fake seam.
9. Description recovery loses its historical scoped parent/child identities.
10. An interrupted push reruns the agent and changes the intended commit set.
    Retain its plan before delegation; only all retained commits on the retained
    branch/head prove acceptance. A partial or absent remote observation cannot
    authorize another push.
11. A cancellation or stolen lease after commit permits push, or one after push
    permits thread/report publication. Commit and push guards precede their
    callbacks; recovery also checks cancellation before publication.
12. Fixture mocks recreate the removed mutation bypass, or a fake completion
    store disagrees with the Postgres owner, batch, or ask uniqueness contract.
13. A fake adapter exposes nested mutable objects that Postgres JSON snapshots
    isolate, or numeric-epoch writes skip the shared fence.
14. Empty unresolved inventory masks a retained push after its thread actions
    completed. Recovery must precede empty-inventory completion and retain its
    original publication inventory rather than admit another attempt.
15. A safe pre-delegation retry keeps a stale plan while pushing newly created
    commits. The selected plan must be saved atomically with the in-flight marker
    only when the existing intent permits delegation.
16. A landed recovered push is followed by closure, cancellation, or lease loss.
    The accepted push can be reconciled, but no successful feature completion or
    thread action may be inferred from the now-invalid write authority.
17. An interrupted plan is missing its base or original inventory, or names a
    different durable item base. A matching remote tip cannot repair missing
    intent evidence; legacy completed records keep their existing reader.
18. A fresh checkout reuses a stashed void push result from another retained
    plan and labels its new commits pushed. Cached acceptance must match the
    selected plan before any completion record or feature output is written.

M8 gives mutation sequencing, completion evidence, ask adoption, and own-verdict
delegation one publication owner. `PublishStepSpec` selects work/resource scope
and replace/progress/batch merge policy. The Postgres and in-process adapters
share snapshot, owner, scope, and numeric-epoch contracts. The old wrappers,
memory durability setup and its failure/reset hooks, and mutation bypass are deleted.

Triage saves its selected push plan with the in-flight marker before delegation.
Recovery validates the durable base, branch, tip, complete commit set, and
original inventory without fabricating a checkout or inferring intended commits
from GitHub. Partial, absent, mismatched, or incomplete evidence stays fail-closed;
provider read failures remain transient. Cached acceptance cannot label a
regenerated checkout successful. Recovery precedes fresh admission and
empty-inventory completion, including after its thread actions resolved.
Commit/push guards check durable cancellation, lease, and PR state before their
callbacks; cancellation or lease loss after acceptance blocks later feature
publication. Legacy completed records retain their reader.

The M5 scoped historical description identity selection (work item, exact
parent scope, `publishDescription` method, exact operation marker; ambiguous or
unprovable rows fail closed) now runs at the start of `publishOnce` through the
store seam's `findRetainedDescriptionSurfaceIdentity`. The Postgres adapter keeps
the M5 SQL; the in-process adapter applies the same selection rule to its rows.

The existing database owner suite retains the M0 golden table and now exercises
both adapters and interrupted-push outcomes. All 22 completion SQL template
literals and 16 operation-key/batch-hash/marker helper definitions are
byte-identical. PR-surface child identities and hashes are unchanged. Exact
`dump-prompt all` comparison remains empty.

The M8 gate passed: 193 unit suites (2,599 tests), 14 dedicated-database
integration suites (534 tests), and disposable-stack verification (534 tests).
Verification left `verify-artifacts/2026-10-02T17-00-55-944Z.md`.
Code, dependency, guard, format, and build checks passed with source/test unsafe
assertion counts unchanged at 87/0.

Integrated onto M0-M7, the same lane passed 188 unit suites (2,599 tests), 14
dedicated-database integration suites (544 tests), and the code, dependency,
guard, format, and build checks with source/test unsafe assertions at 78/0. The
exact `dump-prompt all` comparison remained byte-identical. Triage keeps the M3
execution-context cancellation and lease policy for its commit/push guards; the
publication owner checks the same conditions only inside its own recovery and
push mutation.

## M9 failure modes

Recorded before existing-test or production changes:

1. Two closing APIs select different outputs or bypass the combined check/status
   writer. The verdict owner must expose one close operation.
2. Concurrent closes overwrite the first CAS-selected output or its details hash.
3. Null or omitted epochs publish while work is live, including acknowledgement.
4. Moving selection/application changes the session lock, autocommit ordering,
   lease SQL, operation keys, child hashes, or separate accepted receipts.
5. Repair infers acceptance from check creation, reopens unknown intents, or
   replaces the saved selection with a newly inferred summary verdict.
6. Callers construct divergent details URLs or read repair evidence in a different
   order. The verdict owner resolves the summary URL and owns open-check repair.
7. Consolidation loses accepted-start recording, reservation recovery, orphan
   cleanup, permission soft failures, or cancellation behavior.

The existing agent-work repository integration suite owns first-output CAS,
terminal-only null/omitted epochs (including acknowledgement), and fail-closed
repair. The renamed verdict unit suite retains creation/recovery coverage.

M9 consolidates check creation, combined verdict publication, and terminal
repair in `src/agentWork/reviewVerdict.ts`. The factory returns
`{pending, close, repairIfOpen}`; no independent check-only or cancellation
closer remains. It builds details links from comment IDs, retaining explicit
no-link output on acknowledgement, stale-head replacement, projector, and
sweeper paths. Newly published summary or failure-notice IDs retain their
original link before a durable record exists.

The shared session-lock and fenced-write implementations, repository SQL, CAS
selection, operation keys, delegated child evidence, and separate acceptance
receipts remain unchanged. Existing check-only selection compatibility is
exercised by seeding the retained selection at the repository boundary, then
using the one combined writer. The owner tests exercise the real fake PR
surface with Postgres for races and fail-closed reconciliation.

Integrated onto M0-M8, the lane passed formatting, typecheck, lint, guards, 188
unit suites (2,599 tests), the build, and 14 dedicated-database integration suites
(544 tests). Source/test unsafe assertions stay at 78/0 with no baseline growth.
The complete prompt dump remains byte-identical to M0, SHA-256
`d29f822bfaeba33e5526fd5aa3b618f22eaaf691e9e11052b67a9e1778ae06e5`. The check
close delegation uses the M8 publication owner's delegation gate and marker; the
selection, keys, and receipts above are unchanged.

## M11 failure modes

Recorded before existing-test or production changes:

1. A delivery returns success before its transaction commits, or interruption
   returns a timeout before rollback settles.
2. Ignored and duplicate deliveries emit transactional events before commit;
   rollback leaves replay evidence, quota reservations, work, jobs, or events.
3. Automated admission selects its decision before the review intake lock or
   combines the retained lifecycle read with lock acquisition, missing a winner.
4. Close/reopen ties, irreversible merge, stale observations, approval withdrawal,
   sorted approval locks, or approval head rechecks drift during consolidation.
5. Pure command mapping performs provider I/O, moves authorization ahead of bot
   identity resolution, or authenticates a bot approval or disabled approval.
6. Inline replies lose parent-or-self identity; triage incorrectly treats a root
   comment as a thread reply. CI refresh loses normalized matching-head targets.
7. Canonical ask checks quota before its mention lock and separate retained
   any-status lookup; a repeated mention reserves capacity or enqueues again.
8. Ask reservation and insertion escape one admission owner, lose conflict
   compensation, or change lock/check priorities and provider-window accounting.
9. Consolidation changes durable payloads, queue identities, event field values,
   signature/parsing order, response statuses, or timeout/log emission timing.
10. Deleting SQL-string fakes loses behavior proof. HTTP assertions move to the
    existing HTTP owner; command assertions to the existing intake owner; durable
    predicates and rollback assertions to existing Postgres integration owners.

M11 moves all six scheduler bridges and the five intake transaction variants
behind `runDelivery`. `DeliveryTx.withReviewIntake` acquires the review intake
lock before a separate retained lifecycle read. Automated, slash, close/reopen,
and approval decisions are selected before insertion; no decision patch-up
writer remains. Approval reads lock their matching awaiting row so retention
cannot invalidate the selected decision. Signature verification, parsing,
authorization order, HTTP status/timeout policy, payloads, and queue/event
identities remain unchanged. The Effect and Promise callers use the same owner;
existing integration tests also use its real caller-owned Postgres transaction
adapter, not a test-only hook.

`askQuota.ts::admitAsk` owns mention agreement, reservation, matching insertion,
and compensation. The migrated real-conflict case exposed an existing deferred
foreign-key failure: release left an unmatched losing reservation behind.
Deleting that released, never-matched reservation in the same transaction fixes
the amendment's atomic-admission contract. Outstanding/provider capacity is
released; the existing rate debit remains. Terminal trigger and provider-window
accounting are unchanged. This case failed before that fix.

Coverage migration:

| Removed assertions                                                                                                                             | Strongest retained owner                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature, malformed JSON, parse status, durable success, errors, timeout, and nonblocking successful logging                                  | `verifySignature`, `parseGithubPayload`, `serverHealth`, and `schedulerIgnoredIntake`; actual timeout/rollback is in `intakeTransaction.integration` |
| Bot identity, association policy, mention mapping, merged evidence, inline parent-or-self versus triage parent-only, and normalized CI targets | `intakePlanner`; signed approval and own/foreign CI decisions also run through Postgres in `intakeTransaction.integration`                           |
| Delivery/body dedupe and returned event identity                                                                                               | `webhookDedupe.integration` and `intakeTransaction.integration`                                                                                      |
| Help/unknown replies, triage modes/exclusions/scope, and mixed review/triage close acknowledgement                                             | `intakeTransaction.integration`; active-winner and force races remain in `slashActiveUniqueness.integration`                                         |
| Cancellation predicates, exact epoch release, and unknown epochs                                                                               | `prActorLease.integration` and the intake transaction races                                                                                          |

Explicit drops are SQL text/parameter-count and fake job-inspection assertions,
not their observable outcomes. Three force-conflict fixtures fabricated a slash
winner after every active review had been cancelled under the same intake lock;
upgraded writers cannot produce that state. Real force ordering, rollback,
cancelled-ID receipts, lease release, and sibling-resource isolation remain in
integration. Login sanitization stays with its existing progress owner.
The lane manifest records every deleted case's destination or explicit drop.
No new test/helper/fixture file was created.

Local M11 gates passed: effect versions, production dependencies, code,
guards, build, 188 unit suites (2,571 tests), and all fourteen dedicated
Postgres integration suites (530 tests). Source assertion baseline remains 87.
One full unit attempt hit unchanged Code Mode timing assertions; its isolated
37-case retry and subsequent full unmodified unit run passed. The prompt dump
is byte-identical to M0, SHA-256
`d29f822bfaeba33e5526fd5aa3b618f22eaaf691e9e11052b67a9e1778ae06e5`.
All captured task containers and disposable volumes were removed.
The parent owns final integrated verification, deslop, and commit. This lane
makes no commit, push, or external write.

## M12 failure modes

Recorded before the transition and CI-request changes:

1. A transition loses its race predicate: a cancel request, a stale lease epoch,
   or an already-terminal row is overwritten, so completion revives cancelled work
   or a displaced worker marks the replacement's item failed.
2. Terminal state stops winning: a retry or failure write moves a `completed`,
   `failed`, or `cancelled` row, or a late completion lands after
   `cancel_requested_at`.
3. A shared builder changes what a statement writes: a claim loses its
   `FOR UPDATE` prior-status read, drops the COALESCE on `started_at` or
   `execution_epoch`, or a force-completion overwrites an earlier `completed_at`.
4. A cancel that must release lease holders stops returning the exact
   `(id, execution_epoch)` pairs, or the running cancel stops recording
   `cancel_requested_at`, so the lease release or the in-process skip check breaks.
5. The lost-running sweep loses the age, type, resource-key, cancel, lease-liveness,
   or pg-boss-liveness predicate and fails live work; its `READ COMMITTED` and
   lock ordering must stay in the caller.
6. Queued replacement cancellation changes its three-statement order (queued
   attempt, queued epoch-pinned retry, lease-locked running cancel) and cancels a
   newer epoch's replacement.
7. A status literal drifts from `WorkStatus`, or a second writer reappears and the
   single owner is bypassed.
8. The CI request loses a job identity: the `owner/repo:headSha` singleton key, the
   five-second debounce slot, the `:deferred` key, priority, or installation group
   changes, stranding retained jobs or defeating debounce.
9. An intake request leaves the caller's transaction: the job commits without the
   facts, or an absorbed delivery loses its `correlations` entry, or a missing
   target no longer rolls intake back.
10. A claim-time writer enqueues when the head is seeded at the rendered version,
    or stops enqueuing when it needs a seed or the row moved; an absent queue or
    an installation id of zero starts throwing.

`workItemTransitions.ts::transition` is the only status writer. Callers state the
selector, the statuses they may leave, the `WorkStatus` target, and the guards;
terminal targets stamp `completed_at` and `running` stamps `started_at`. A
numeric `leaseEpoch` adds the existing lease-fence predicate; null or omitted
adds none. The fence is a predicate only: the earlier `fencedWrite` wrapper on
these writers requested neither precheck nor recheck, so it did nothing and is
gone from them. Each repository keeps its domain wrapper and its lock ordering
(`markQueuedWorkCancelled`'s three statements, `markLostRunningWorkFailed`'s lock
sequence, cancel-then-release for review and triage close). The 14 status
`UPDATE` statements in `src/` (the plan estimated 22) become `transition()` calls;
the cancel-request-only write in `autoWorkEnqueue.ts` keeps status `running` and
is not a transition. Initial `queued` inserts stay in intake. `check:guards` now
fails on any other `UPDATE agent_work_items ... SET status`.

`ciProjection.ts::requestHeadCiProjection` replaces the transactional,
standalone, deferred, and due-checked variants and their thirteen callers. The
`intake` schedule keeps the in-transaction send and correlation merge, `debounced`
keeps the transaction-free send, `after` keeps the `:deferred` singleton, and
`when_due` keeps the seed/version check, the missing-queue skip, and the
installation-id guard. Job payloads, queue, priority, group, debounce seconds, and
singleton keys are byte-identical.

Coverage migration: no removed assertion was SQL-text only. The unit mocks that
named the old enqueue functions now mock `requestHeadCiProjection`, and the
integration cases for debounce, absorption, and due checks call it directly. The
existing `agentWorkRepository.integration` owner gains behavior cases for the
shared guards: a stale lease epoch cannot move running work to completed, failed,
retrying, or cancelled; a recorded cancel request wins over completed, failed,
and retrying; terminal rows stay terminal against later writers. Claim,
force-completion, replacement cancellation, close cancellation, supersede, and
the lost-running sweep stay with their existing owners (`agentWorkRepository`,
`prActorLease`, `staleQueuedWork`, `intakeTransaction`, `slashActiveUniqueness`).
No new test, helper, or fixture file was created.

Local M12 gates passed: effect versions, production dependencies, code, guards,
build, 181 unit suites (2,532 tests), and all fourteen dedicated Postgres
integration suites (577 tests, eleven new guard cases). Source assertion baseline
remains 78. The prompt dump is byte-identical to M0, SHA-256
`d29f822bfaeba33e5526fd5aa3b618f22eaaf691e9e11052b67a9e1778ae06e5`.
`AGENTS.md` sits 25 bytes under the 32 KiB trusted-instruction file cap, so
further additions there need a matching trim.

## M13 failure modes

Recorded before the leased-execution move:

1. A stale epoch writes: a terminal or attempt mark loses its lease-epoch
   predicate, or unleased work stops passing `null`, so a displaced worker moves
   the replacement's row.
2. The lease is lost mid-run: renewal stops aborting the host signal, or the
   release in `finally` clears a newer holder because it no longer names its own
   epoch.
3. The process crashes between the terminal mark and the lease release: the row is
   terminal while the lease remains until TTL. The release stays last, and the
   seeded watchdog chain still steals the key.
4. A replacement abort races a claim: the abort moves out of the runner and
   cancels an `enqueued` replacement, or skips a pending one because the parent
   was unreadable, leaving an orphan queued item.
5. The watchdog hop spends a retry: the seed, the strict re-arm, or a lease
   deferral reaches `beginWorkAttempt` and charges the attempt budget.
6. The `40P01` retry changes: acquire-and-claim or `beginAttempt` retries more than
   once, retries another error code, or lets the failed attempt's epoch leak into
   renewal or release.
7. A terminal item is redelivered: a second claim succeeds, or a terminal hook runs
   twice because the mark lost its race.
8. Order drifts: terminal mark after the feature hook, release before the hook, or
   the watchdog seed after acquire, so a crash strands a held lease with no hop.
9. A feature-specific degradation reason is widened into the runner, so an
   unknown reason string compiles and reaches telemetry unreviewed.
10. The barrel deletion changes an import target and a mock silently stops
    intercepting, so a unit test hits a stub pool.

`leasedExecution.ts::openLeasedExecution` is the single owner of lease ordering:
it seeds the throttled watchdog hop, acquires the PR actor lease and claims the
item in one transaction, then starts renewal and cancel observation. It returns
the epoch, claim, signal, `owns`, `cancel`, the lease mutation boundary, and
fenced `mark.{beginAttempt, headSha, degraded, completed,
forceCompletedRescheduledParent, retrying, failed, cancelled}`. SQL, fencing
predicates, log names, and the 40P01 single retry moved verbatim from
`durableJob.ts`. `release` stops observation and renewal, then releases the
exact epoch and logs `pr_actor_lease_release_failed` on failure. The runner order
is unchanged: terminal mark, feature terminal hook, acknowledgement reaction,
completion log and telemetry, then release in `finally`.

Review owns the stale-head replacement abort. `onRescheduleAbort` and the
runner's pending-abort bookkeeping are gone. `reviewExecutor`'s
`onTerminalFailure` first calls `cancelPendingStaleHeadReplacement(pool, parent,
error)`, which rereads the parent, skips when no marker exists or the persisted
state is `enqueued`, and otherwise runs the existing state-predicated
`markQueuedWorkCancelled` fallback. An unconfirmed cancel logs
`agent_work_replacement_cancel_failed` at error level, rethrows, and is swallowed
by the hook so verdict close still runs. Behavior differences from the runner
implementation: the parent is reread (a persisted `enqueued` marker now exempts
it, matching the documented terminal fallback), and the hook runs with an
undefined surface when surface creation fails, after logging a warning.

Each feature owns its degradation reasons: `VerificationDegradationReason` in
`verificationPublishGate.ts`, and private triage, ask, description, and review
unions, checked with `satisfies` at the literal sites. `DurableExecutionResult`
carries `readonly string[]`. `agentWork/repository.ts` is deleted; importers use
`workItemStateRepository`, `publishRecordRepository`, and
`operationIntentRepository`, with their unit mocks retargeted. The
`createAgentWorkRepositoryMock` test helper became `createPublishRecordReadMock`.

Coverage migration: the 38 lease, claim, cancel, and watchdog cases stay in
`test/leasedExecution.test.ts` (renamed with `git mv` from the old suite; five cases are new). The
retry, terminal-hook, completion, rescheduled-parent, installation-token, context
policy, and assignability cases stay in a slimmer `test/durableJob.test.ts`.
Four `onRescheduleAbort` cases were replaced by seven `reviewReschedule` unit
cases for `cancelPendingStaleHeadReplacement` and two review terminal-hook cases
(abort runs before the verdict close, with and without a surface). New
`leasedExecution` cases assert the `40P01` single retry for both
acquire-and-claim and `beginAttempt`, no retry on other errors or on a repeated
deadlock, watchdog seed, acquire, claim, terminal mark, release order, and that
a lease deferral never reaches `beginWorkAttempt`. Integration suites
(`prActorLease`, `leaseDeferral`, `slashActiveUniqueness`) call the new owners.
No test file is new beyond the split of one existing suite; no helper or baseline
growth.

## M14 failure modes

Recorded before the review split:

1. The two publishers disagree on a failed abort check (B7): the batch publisher
   propagates it so the durable job retries, while the summary publisher logged
   `review_summary_abort_check_failed` and read it as supersession. A transient
   head lookup then finishes the run as stopped with no summary.
2. The abort policy forks again: a second copy of `shouldAbortPublish` and
   `publishAbortState` lets one publisher report `stale_head` where the other
   reports `superseded`.
3. A step is skipped or repeated: recon, brief repair, dispatch, synthesis,
   summary repair or recovery, or the deterministic summary runs out of order, or
   a retired session reaches synthesis.
4. A terminal path loses its closing write: the host-abort stop, the model
   deadline, an all-failed specialist set, or a retired session ends without the
   terminal tick, failure notice, or deterministic summary.
5. The injected session factory is bypassed: the recon, judgment, or a specialist
   session is built from the module import, so a test or the executor cannot
   substitute it.
6. Trusted-context assembly drifts in the move: a prompt byte, a policy or
   agent-instruction cap, the same-repo trust decision, or the forged-header
   neutralization changes.
7. The review circuit diverges from ask: hydration from the shared row stops
   honoring `openUntil`, a failed shared read aborts the run, or the opened
   callback stops publishing the shared row.
8. The executor loses a terminal hook: `onCancelled` or `onTerminalFailure` (stale
   replacement abort, verdict close) stops running when the feature body moves.
9. A move changes an import target and a module mock silently stops intercepting.

`runReviewForWorkItem.ts` is the review feature entry. It owns trusted-context
assembly (`assembleTrustedReviewContext`, moved verbatim), session and workspace
setup, publish, and the terminal outcome. `reviewExecutor.ts` keeps the work
definition wiring, `onCancelled`, and `onTerminalFailure`, and delegates
`execute`. `createSession` reaches the run through
`WorkExecutionDependencies.createSession` (default `createFeaturePiSession`) and
`OrchestratedReviewRunParams.createSession`, then to every specialist.

`orchestrator/runStep.ts::nextStep(last, facts)` is pure. `orchestratorRun.ts`
executes the chosen step in a `runStep` switch; the step bodies moved verbatim.
`publish/reviewPublishSession.ts` builds one `ReviewPublishSession` per run
(identity, summary coordination, verdict target, and the single `stopReason()`).
`publishFindingBatch(batch, session, input)` and
`publishReviewSummaryOnly(session, input)` take it, and the publish tools take
`{phaseRef, session, ...}`. The dead `remainingFinalizationMs` parameter is gone.
`agent/runtime/rateLimitCircuit.ts::openRunRateLimitCircuit` is the one opener
for ask and review; `runWithRateLimitCircuit` stays in `github/rateLimitCircuit.ts`.

B7 resolves to propagate. A failed abort check never reads as supersession and
never authorizes publication, and the existing batch test already required that
behavior. Evidence: the new `propagates abort-check failures so the durable job
can retry` case in `test/publishSummaryOnly.test.ts` failed before the change (the
call resolved `{kind: "stopped", reason: "superseded"}`; 1 failed, 5 passed) and
passes after (6 passed).

Coverage migration: `orchestratorRun.test.ts` drops the `createFeatureSession`
module mock (the factory is injected) and gains 27 `nextStep` table cases (21
routes and 6 terminal rows) in the existing suite. The one deleted case asserted
`ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS` equals 4, a constant with no behavior.
`reviewExecutor.test.ts` drops the `sharedRateLimitCircuit` module mock and the
`createRateLimitCircuit` spy; its metric case trips the real circuit through
`getActiveRateLimitCircuit`. The `continues review when shared rate-limit circuit
read fails` case moved to `sharedRateLimitCircuit.test.ts` as
`openRunRateLimitCircuit continues the run when the shared read fails`, beside two
new opener cases (hydration, callback and shared publish). The publisher, tool,
and `ciProjection` integration suites migrated to the session signatures through
`publishSummaryForTest` in the existing helper file. The `repoPolicy` and
`agentInstructionFiles` tests are unchanged. No test file is new; the unsafe
assertion baseline did not grow.

Remaining module mocks in `orchestratorRun.test.ts` (`specialistRun`,
`publishThreadTool`, `publishSummaryTool`, `stubTick`, `reviewRunFallback`,
`publishSummaryOnly`, `publishRecordRepository`, `reviewRunSetup`,
`agentEventSink`) and the executor's `orchestratorRun` mock stand in for I/O that
needs a database-backed pool and a diff-indexed fake surface to run for real. They
are a recorded follow-up, not part of this milestone.

## M15 failure modes

Recorded before moving code:

1. A stale head renders another head's cell. The head-and-version guard in
   `replaceCiSummaryCellIfNewer` and the `supersededHead` option must move
   byte-for-byte.
2. An unseeded head renders passing or none. The `unknown` rollup and the
   incomplete-listing summary (`REVIEW_CI_SUMMARY_INCOMPLETE`) keep their
   branches; waiting copy stays `WAITING_FOR_CI_SUMMARY`.
3. A pending or `unknown` head spends more than one Checks listing per job. The
   seed and pending-refresh code in `prHeadCiState.ts` and the projector are
   untouched; `prHeadCiState` keeps its keep verdict and is not folded.
4. Truncated logs lose their failure line. `boundRawLogIntake` moves verbatim.
   It is idempotent, and `condenseJobLogText` already applies it with the same
   default cap, so removing the bound from `actionsLogs` leaves the condensed
   bytes identical.
5. The LLM author fails or returns junk. `createAgentCiSummaryAuthor` still
   returns `null` after `review_ci_summary_author_failed`, and `ciAuthoring`
   still falls back to `factsOnlyFailingSummary`.
6. Log excerpts leak credentials. `redactReviewText` still runs at the
   per-job condense, merge, and byte-bound steps and on merged headlines,
   reasons, and fix hints.
7. A lower layer imports upward. `src/github/actionsLogs.ts` imported
   `review/ci/rawLogIntake`; it now returns the raw log and imports nothing
   from `src/review/`.
8. Version races. `shouldReplaceCiRollupMarker`, the cell and action-phrase
   decision, and the verification-block injection keep their predicates; the
   duplicated cell regex, end marker, and attribute parser become one copy.
9. Prompt bytes drift. `CI_SUMMARY_SYSTEM_PROMPT` and `buildCiContextUserMessage`
   move verbatim; the M0 prompt dump is compared byte-for-byte.
10. Re-export shims keep dead names alive. `renderCiSummary`, `condenseCiLogs`,
    and `analyzeCi` re-exported other modules; importers now use the owner.

### M15 ownership and coverage

`src/review/ci/` holds three files. `ciFacts.ts` owns the snapshot and fact
types, `classifySnapshot` and merge rules, the facts-only summary, the authored
cache (`hashCiFacts`, `parseCiAuthoredCache`), and `ciSummaryFromFacts`.
`ciAuthor.ts` owns the LLM schema and prompt, raw intake bounding, condensing,
context selection, `fetchCiAuthorContext`, and the author turn.
`ciSummaryCell.ts` owns cell rendering, the CI, rollup, and verification-failure
markers, and the head and version replacement rule. `reviewMetaParse.ts` moved
to `run/commentMarkers.ts` beside the other marker codecs. `agentWork/ciAuthoring.ts`
stays in `agentWork/` because it writes `pr_head_ci_state`.

Coverage migration: `analyzeCi.test.ts` became `ciFacts.test.ts`,
`condenseCiLogs.test.ts` became `ciAuthor.test.ts`, and `renderCiSummary.test.ts`
became `ciSummaryCell.test.ts`; the rendered-cell cases are unchanged except for
import paths. `ciSummarySchema.test.ts` split into those suites (nine author
cases to `ciAuthor`, five facts and cache cases to `ciFacts`) and was deleted, as
was `reviewMetaParse.test.ts` (two cases moved to `progressComment.test.ts`). The
two `fetchCiAuthorContext` cases moved from `ciFacts` to `ciAuthor`. The two
`actionsLogs` raw-bound cases duplicated the `boundRawLogIntake` cases in
`ciAuthor`; they became one case that asserts the log is returned unbounded, and
`ciAuthor` gained one case that drives a huge download through
`fetchCiAuthorContext`. No test file is new. The unsafe assertion baseline stays 78.

## M16 failure modes

Recorded before the narrowing:

1. A removed read changes its bytes when its caller composes it: prior-feedback
   threads, bot finding threads, thread-root resolution, review-comment links, or
   the published-batch lookup change a lens decision, a reply, a cap, or an order.
2. The bot-authored filter is lost when `findPublishedThreadBatch` stops being a
   surface method, so recovery adopts a human review that carries the marker.
3. A truncated comment listing reads as complete: the review-comment cap stops
   being reported once three methods share one listing.
4. Description publication changes its request: title, body, the
   `titleRewrite` decision, the operation-marker suffix, or the skip-when-equal
   rule differs from the old merge-and-write.
5. Retained description identity breaks: a row persisted under `publishDescription`
   no longer resolves its key, recovery lookup, or identity once the method is
   renamed, or a second row is written for the same marker.
6. The exhaustive mutation switch stops being exhaustive, so a new write skips the
   intent boundary or recovery.
7. A leased read becomes fenced, or a removed method leaves a caller that now
   crosses the boundary.
8. A dead method survives in the fake or the real surface, so tests keep passing
   against behavior production no longer has (`listCheckRunAnnotations`,
   `isRateLimitCircuitOpen`, `rateLimitCircuit`).

`PrSurface` goes from 40 to 32 methods (20 reads, 12 mutations). The surface keeps
raw reads and writes; feature assembly moved to its owner.

Removed methods, former callers, replacements:

| Removed                                                       | Former callers                                                                                            | Replacement                                                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `fetchPriorInlineFeedback`                                    | `reviewTrustedContext` (via `runReviewForWorkItem`)                                                       | `reviewPriorFeedback.fetchPriorInlineFeedback(prSurface, ...)` over `listReviewComments` and `listPullRequestReviews` |
| `fetchBotFindingThreads`                                      | `triageExecutor`, `verificationExecutor`                                                                  | `reviewPriorFeedback.fetchBotFindingThreads(prSurface, ...)`                                                          |
| `fetchReviewCommentParentGraph`                               | `triageExecutor`                                                                                          | `listReviewComments` plus `resolveReviewThreadRootId`                                                                 |
| `findPublishedThreadBatch`                                    | `publishFindingBatch`, `recoverPrSurfaceMutation`                                                         | `prSurfaceHelpers.findPublishedThreadBatch(surface, ...)` over `getBotLogin` and `listPullRequestReviews`             |
| `listInlineReviewComments`                                    | `askThreadContext`, `recoverAskReply`, `publishTriage`, `publishVerification`, `recoverPrSurfaceMutation` | `listReviewComments`                                                                                                  |
| `listPullRequestReviewComments`                               | `publishSummaryOnly`                                                                                      | `listReviewComments`                                                                                                  |
| `getPullRequestBody`                                          | `submitDescriptionTool`, `descriptionExecutor`, `recoverPrSurfaceMutation`                                | `getHead().pullRequest.body`                                                                                          |
| `getPullRequestBranchInfo`                                    | `triageExecutor`, `publishTriage`                                                                         | `getHead` plus `pullRequestBranchInfo` in `listPullRequestFiles.ts`                                                   |
| `publishDescription`                                          | `submitDescriptionTool`                                                                                   | `updatePullRequest({title, body}, marker?)`; merge in `descriptionPublishPlan.ts`                                     |
| `listCheckRunAnnotations`                                     | none in production                                                                                        | deleted with its Octokit reader and constants                                                                         |
| `isRateLimitCircuitOpen` and the `rateLimitCircuit` parameter | none in production                                                                                        | deleted                                                                                                               |

`reviewPriorFeedbackIo.ts` and the review-comment, review-marker, and annotation
readers in `reviewPublish.ts` and `ciStatus.ts` are deleted. The shared
`listReviewComments` result carries `truncated`; the cap is unchanged.

Description wire identity: `updatePullRequest` persists under `publishDescription`
for the operation-key segment, `mutationKind`, and `surfaceMethod`
(`PR_SURFACE_WIRE_NAMES`, one table that also drives recovery). The retained-identity
lookup, the golden retained-child cases, and recovery by marker are unchanged.
This is a deviation from "child hashes keep their bytes": the argument is now
`({title, body}, marker)` instead of `(Config, payload, marker)`, so a new
description child hashes to `4e5225fc7e449cdf82f2658758e5890a83f86ce5b6aa6a8e85479d492c437f0c`
for the golden input (was `bf162594f55498fbf415bfab2fe1436e1dc15c53221dc7a4b34fa0eed967bb33`).
The M5 full-Config hash shim is removed with the argument it served. A retry of a
description publish that started before deploy still resolves its row by exact
parent, work item, name, and marker, so the old key and hash are reused and no
second request is sent. The request bytes (`pulls.update` title and body) and the
persisted marker are unchanged.

Coverage migration: `fakePrSurface` shrinks from 813 to 731 lines. It drops the
events and controls of every removed method (`setRateLimitOpen`,
`setPriorInlineFeedback`, `setBotFindingThreads`, `setReviewCommentParentGraph`,
`setInlineReviewComments`) and gains `setReviewComments`, `setPullRequestReviews`,
and `updatePullRequest`; published batches appear as bot reviews. Existing suites
migrated without new files: `reviewPriorFeedback` and `triagePriorFeedback` call
the feature functions through the real surface over mocked Octokit pages, so
pagination, mapping, lens, and authorization cases still run end to end;
`reviewTrustedContext` seeds raw comments instead of canned threads;
`triageExecutor` and `verificationExecutor` seed raw listings through two
functions added to the existing `executorDurableHarness.ts`
(`seedBotFindingThreads`, `seedReviewCommentGraph`); `reviewPublish` moves the
bot-author filter case to `findPublishedThreadBatch`; `submitDescriptionTool`
asserts the title and body passed to `updatePullRequest` in place of the payload
passed to `publishDescription`; `githubPrSurface` gains one request-shape case for
`updatePullRequest`. The `prActorLease` read and mutation inventories, the
`publishRecordBatches` golden table, and the `ciProjection` race seed follow the
new method names. Deleted assertions: the `isRateLimitCircuitOpen` check and the
`listCheckRunAnnotations`, `listInlineReviewComments`, `getPullRequestBody`, and
`getPullRequestBranchInfo` rows in the read inventory. The thread-root-resolution
failure case now fails the second real listing instead of using an empty canned
graph. Triage fixtures that replace the pull request now carry `head.ref` and repository
names, since branch info comes from `getHead`. The unsafe assertion baseline stays at 78.

## Consequences

No new test files or main-site copy changes. Existing invariant owner tests stay
at their strongest boundary. Baselines may only shrink. Web and worker keep the
same persisted payloads and deploy together when internal contracts move.

M5 proves that the checkpoint and resume-snapshot tables have no readers outside
that removed subsystem. ADR 0023 decision 6 now keeps operation intents and
publish records authoritative without retaining unused session state. Migration
036 drops only those two tables; earlier migrations are unchanged.

### M5 description input compatibility

M0's `publishDescription` child hash is
`bf162594f55498fbf415bfab2fe1436e1dc15c53221dc7a4b34fa0eed967bb33`.
The surface hash builder retains removed defaults only as deliberate compatibility
metadata for new full-Config arguments (identified by `piThinkingCeiling`).
Narrowed Pick arguments are unchanged and explicitly supplied old properties win.
This does not claim that defaults recreate historical non-default hashes.
M16 removes this shim; see the M16 section for the new description hash.

Before persisting any description surface child, the durable intent boundary
looks up its retained identity by work item, exact parent frame (including no
parent), surface method, and exact operation marker. One valid retained row
supplies the original operation key and input hash, regardless of removed Config
values or row status. It is selected before entering the child frame, so nested
mutation keys retain the old parent too. It follows the existing result,
unknown-outcome, and provider-proven failed retry paths without special status
handling. No env reader, schema change, global hook, or row rewrite is added.

Multiple matches, malformed key/hash metadata, or an unmarked retained child
whose key differs from the incoming key fail closed before persistence. Same
method with another parent or marker is not a match. Abort and lease ownership
checks precede lookup and still fence the selected intent and each mutation.

The existing publication integration owner first demonstrated 11 failures against
real task-owned Postgres. It now proves framed and standalone historical children
in reconciled, pending/__mutating, outcome_unknown, and provider-proven failed
states, plus ambiguous, malformed, and missing-marker refusal. The legacy fake
Config used `fake-historical-key` and margin `1234`; its precomputed input hash is
`50066c7921debb1bef12c704a6c3d26fc43acbd7d647bcb52877a0847fbf08d7`.
Replays keep that key/hash and create no sibling intent. Reconciled/unknown rows
never remutate; only the already-retryable failed row may mutate once on the same
key, then replays quietly. Other scoped rows remain byte-identical.

## M6 failure modes

Write these before changing owner tests or code:

1. Core calls `finishTurn` before `turn_end`; counting both consumes the
   investigation budget twice or starves the reserved terminal tool. Mixed turns
   count both budgets; one successful reserved turn or two attempts end it.
2. Retry or overflow continuation reorders the user prompt, assistant turns, and
   tool results, or drops provider-error usage from the final aggregate.
3. Moving retries changes their cap, exponential delay, abort signal, event order,
   or error precedence. Overflow compaction has its own cap and precedes retry.
4. Window compaction loses its role policy, leading system prompt, safe transcript
   boundary, original stream options, or event fan-out.
5. Idle monitoring confuses wall-clock duration with inactivity, misses streaming
   or tool activity, changes timeout polling during continuation, or leaves an
   earlier continuation's interval alive after the send finishes.
6. Cancellation, duplicate-call refusal, tool-budget completion, provider failure,
   and output-limit outcomes lose their existing ordering or public error codes.
7. Session disposal or an aborted session becomes reusable, or internal extraction
   changes the public PiSession adapter contract, prompts, tools, or cache identity.

The existing createPiSession, seam, compaction, stream, lifecycle, and feature
adapter tests are the owner evidence. A narrow assertion in the existing retry
case first pins cleanup of every idle interval acquired by that send. Polling
and activity reset timing stay unchanged during the send; only orphaned intervals
are released at its existing terminal cleanup boundary.

### M6 ownership

`piSessionImpl.ts` retains model/tool setup, phase and duplicate-call gates,
lifecycle/usage projection, outcome precedence, and public session lifetime.
`turnToolBudget.ts` owns pre-event finish decisions and post-event accounting.
`sessionTurnLoop.ts` owns Core start/continuation, transcript adoption, and the
existing capped exponential turn retry. `sessionCompaction.ts` owns role-gated
window compaction and separately capped overflow compaction.
`sendActivity.ts` owns inactivity races and all polling intervals for one send,
plus abortable retry waits. It releases every acquired interval at terminal
cleanup and releases completed retry-wait listeners. Polling cadence, continuation
activity resets, transport retry options, caps, delay constants, event bytes,
and error precedence remain unchanged. No new jitter or provider retry policy
is introduced. PiSession and its injected fake adapter are unchanged.

## M7 failure modes

Write these before the existing owner tests and implementation:

1. A triage grep buffers 20 MiB instead of the shared search byte cap, or a
   buffer-cut result claims an exhaustive absence. Preserve truncation.
2. Consolidating tools changes their ordered names, descriptions, schemas,
   response wire shapes, spill cleanup, delivered-read evidence, or telemetry.
3. A read profile permits sensitive/control paths, traversal, gitlinks, or
   symlink escapes; review/ask must still allow sensitive changed paths only.
4. A reader loses pinned-head diff/blame semantics, sparse coverage, literal
   path chunks, Unicode repair, or Git 2.39 compatibility. NUL-delimited grep
   must not mistake a colon-containing path for a line-number delimiter.
5. Moving Git execution loses hooks, credentials, timeouts, identity validation,
   fetch limits, or final commit/push guards. M13 still owns execution-window
   consolidation; M7 cannot weaken those guards.
6. Lifecycle narrowing leaks credentials, forgets read-only permissions or
   symlink removal, or skips cleanup after preparation failure.
7. Removing resource test hooks hides heartbeat, live-root, release, or stale
   sweep failures. Exercise allocation, on-disk markers and sweeping directly.
8. A caller or fixture retains the old wide workspace methods, or a second
   adapter is unused. Pinned and writable production workspaces own readers.

### M7 ownership and compatibility

`localPrWorkspace.ts` keeps pinned-head preparation, credential removal, stripped
symlinks, read-only permissions, fetch/disk limits and failure cleanup. Its value
now has a reader instead of forwarding read methods. `repositoryReader.ts` owns
the pinned and writable production adapters, bounded filesystem reads, cached PR
patches/blame, NUL-delimited literal grep, path chunks and profile path policies.
`workspaceToolset.ts` owns the ordered read profiles and executor marshalling.
Triage keeps its existing write tools and final commit/push guards; M13's execution
window remains separate. Commit-attribution helpers moved to triage's owner.
Resource allocation/sweep tests use actual disk markers, not exported registry
or heartbeat helpers. Read tests live in the renamed `workspaceToolset.test.ts`;
triage write/commit tests remain with their existing owner.

B4 and colon-path search cases failed before implementation. The former exceeded
the old 20 MiB buffer; it now returns a truncated result at the existing
50,000,000-byte search cap. The latter no longer drops a colon-containing path.
Filtered-search events and properties retain their bytes. The complete M0 prompt
and tool dump stays byte-identical with SHA-256
`d29f822bfaeba33e5526fd5aa3b618f22eaaf691e9e11052b67a9e1778ae06e5`.
