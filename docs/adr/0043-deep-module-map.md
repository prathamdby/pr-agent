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
