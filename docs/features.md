# Features

The eight `FEATURE_*` settings are pr-agent's entire user-facing configuration.
Everything else is deployment wiring or operator tuning (see
[configuration.md](configuration.md)).

Modes for describe and verification: `off` = disabled entirely (slash
commands reply with a notice, nothing runs), `manual` = slash command only,
`auto` = slash command plus an automatic trigger. `FEATURE_ASK` and
`FEATURE_TRIAGE` accept only `off` or `manual`. `auto` is invalid and crashes
startup. `FEATURE_REVIEW` accepts `manual`, `auto`, or `approval`. `off` is
invalid and crashes startup.
`/review` is available in every review mode on open PRs. Auto triggers are fixed: review and describe fire when
a PR is `opened`; verification fires on `synchronize` (every push). With
`FEATURE_REVIEW=approval`, trusted PRs are reviewed on `opened`. Trust means
a same-repo head or an author associated as `OWNER`, `MEMBER`, `COLLABORATOR`,
or `CONTRIBUTOR`. Missing association or a deleted fork is untrusted.
Untrusted forks get one awaiting notice. The first `workflow_run` `in_progress`
with `event=pull_request` on the awaiting head, submitted approving review from
a non-bot reviewer in `SLASH_ALLOWED_ASSOCIATIONS`, or `/review` approves that
record once. Completed runs never approve it. Later signals do nothing.
Already-open PRs are not backfilled; use `/review`.
Approval is the default, so trusted opens now spend review tokens; use `manual`
to opt out. `CONTRIBUTOR` authors remain trusted even when your Actions policy
requires workflow approval for all external contributors. A push
while an auto review is still running cancels that review and replaces it with
one for the new head; a push after the review finishes does not re-review.
Custom trigger sets are intentionally not supported.

`/cancel` blocks new review output when the worker's final publication check sees
the cancellation. Requests already in flight cannot be withdrawn. The cancellation
notice and check closure still run. There is no additional feature mode.

A failed stale review's pending replacement is cancelled even if it has just
started or a delivery races the abort. Successfully handed-off replacements remain
unchanged. Unconfirmed cancellation is logged as an error.
Retrying a stale review keeps changes already saved on its replacement.

`/review force` cancels any queued or running review and starts a fresh one on
the latest commit. Concurrent restarts are applied in intake order, not
treated as already-in-progress requests. Ordinary `/review` still deduplicates
against active slash reviews.

After PR Agent accepts a close or merge, automated review intake and `/review`
(including `force`) and stale-head replacements cannot start another review. Commands reply on their original
thread: reopen a closed PR before retrying; a merged PR cannot be reviewed.
A newer provider-observed reopen restores admission but starts no automatic
review. Equal close/reopen timestamps remain closed. Other features keep their
existing policies. See [operations.md](operations.md) for coverage and rollout limits.

Repeated `/review`, `/describe`, `/triage`, and `/verify` commands are
acknowledged without duplicate active slash work. A cancellation racing that
decision no longer causes a missing-winner intake failure. A cancellation or
completion that finishes first can allow a fresh run. `/ask` and `/help` do
not use this active-work gate. Ask instead deduplicates per triggering
comment: repeated accepted deliveries of the same `/ask` or App-bot mention
(same installation, PR, comment surface, and comment ID) join the retained
run in any status without a second answer, ack, quota charge, or queue job.
A new comment is a new question, even with identical text in the same
thread. The join lasts until the work item is purged by
`AGENT_WORK_RETENTION_SECONDS`.

| Setting                 | Values                             | Default    | Spends tokens? | What it does                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------- | ---------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEATURE_REVIEW`        | `manual` \| `auto` \| `approval`   | `approval` | yes            | Orchestrated review. `auto` reviews on open; `approval` reviews trusted opens and holds untrusted forks until maintainer approval. `/review` works in every mode on open PRs.                                                            |
| `FEATURE_DESCRIBE`      | `off` \| `manual` \| `auto`        | `auto`     | yes            | PR description generation. `auto` runs when a PR opens; `/describe` re-runs on demand.                                                                                                                                                   |
| `FEATURE_VERIFICATION`  | `off` \| `manual` \| `auto`        | `auto`     | yes            | Re-checks open findings on synchronize or on-demand `/verify`. Silently resolves fixed threads and edits stubs. Terminal failure edits the CI cell or one stub line.                                                                     |
| `FEATURE_ASK`           | `off` \| `manual`                  | `manual`   | yes            | `/ask` and App-bot mention question threads.                                                                                                                                                                                             |
| `FEATURE_TRIAGE`        | `off` \| `manual`                  | `manual`   | yes            | `/triage` autofix plus `/triage preview` then `/triage all` (preview required before bulk).                                                                                                                                              |
| `FEATURE_REVIEW_LABELS` | `off` \| `size` \| `size+security` | `size`     | no             | Size and security labels. `off` still syncs `Category: bug\|security\|performance\|style` when a finding has a category or a managed category label already exists.                                                                      |
| `FEATURE_COMMIT_STATUS` | `false` \| `true`                  | `false`    | no             | Posts `pr-agent/review` on the PR head. `pending` when the check starts. `success` or `failure` from published findings. `error` on cancel, supersede, stale head, crash, unpublished, or partial coverage. Usable in branch protection. |
| `FEATURE_TITLE_REWRITE` | `false` \| `true`                  | `true`     | no             | Allows `/describe` to rewrite the PR title using make-pr default title rules (imperative sentence case, no type prefix, no trailing period, at most 60 characters). Set `false` to keep the existing title.                              |

Notes:

- Recovering a run does not use another retry unless PR Agent starts another
  work attempt. Interrupted work attempts still count. Previously failed runs
  are not reopened automatically.
- After an interrupted publish, PR Agent checks the saved result and available
  evidence. If it cannot confirm the result, it stops that run rather than
  repeat the change. An unpublished review gets the usual failure notice;
  an existing published summary is kept. Failed or incomplete evidence reads
  can retry.
- With no open findings, verification skips the agent after checking the live
  head. An older-head run completes degraded instead of clean and preserves
  any existing verification failure signal.
- `FEATURE_REVIEW` has no `off`: review is the product; `/review` is available in every mode on open PRs.
- A replacement review owns the progress comment. Late specialist ticks from
  the earlier run are skipped or rejected with an ownership warning.
- Late older ticks from the same review do not replace newer progress or its final summary.
- Describe, verification, ask, and triage can be turned `off` to stop those
  surfaces from spending tokens at all. Default `FEATURE_VERIFICATION=auto`
  spends tokens on `synchronize` pushes with open findings.
- Ask mentions match the App bot login (`{slug}[bot]`), not the literal string
  `@bot`.
- An ask answer cut off by the model's output limit is retried as a shorter
  answer without tools, at most twice. If the answer is still cut, the reply
  ends with a notice that it may be incomplete.
- `FEATURE_REVIEW_LABELS=off` stops size and security labels only. Category
  labels still sync.
- `FEATURE_COMMIT_STATUS` and the `PR Agent Review` check run share one writer
  (`closeOwnVerdict`). A crash concludes the check as `action_required`. A
  published P0–P2 finding concludes it as `failure`.
  Concurrent closes keep the first verdict. A later cancellation or recovery
  does not replace it. The optional status uses that same verdict.
  Crash recovery serializes its failure decision with lease renewals and
  restarted jobs. Busy or timed-out recovery passes leave work alone and retry later.
- Invalid values fail startup with the allowed list; typos never silently
  disable a feature.
- Pre-revision variables (`ENABLE_*`, `*_AUTO_ACTIONS`,
  `DESCRIPTION_GENERATE_TITLE`, and the old tuning knobs) are ignored; use
  `FEATURE_*` only. There are no aliases.

Defaults reproduce the pre-revision out-of-the-box behavior exactly.
Local Compose (`docker-compose.dev.yml`) boots with these same defaults.
It does not add a feature key.
CI enforces that every `FEATURE_*` key is documented here
([`test/settingsInventory.test.ts`](../test/settingsInventory.test.ts)).

Description, verification, and triage share bounded submit repairs. If a repair
hits its tool budget without submitting, the last validation error is retained
for the next repair and the final diagnostic. Ask remains a direct session run.
Session computation is in memory; durable work and publication recovery remain
backed by work items, operation intents, and publish records.
