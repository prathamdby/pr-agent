# Features

The eight `FEATURE_*` settings are pr-agent's entire user-facing configuration.
Everything else is deployment wiring or operator tuning (see
[configuration.md](configuration.md)).

Modes for describe and verification: `off` = disabled entirely (slash
commands reply with a notice, nothing runs), `manual` = slash command only,
`auto` = slash command plus an automatic trigger. `FEATURE_ASK` and
`FEATURE_TRIAGE` accept only `off` or `manual`. `auto` is invalid and crashes
startup. `FEATURE_REVIEW` accepts only `manual` or `auto`. `off` is invalid
and crashes startup.
`/review` always works. Auto triggers are fixed: review and describe fire when
a PR is `opened`; verification fires on `synchronize` (every push). A push
while an auto review is still running cancels that review and replaces it with
one for the new head; a push after the review finishes does not re-review.
Custom trigger sets are intentionally not supported.

| Setting                 | Values                             | Default  | Spends tokens? | What it does                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEATURE_REVIEW`        | `manual` \| `auto`                 | `auto`   | yes            | Orchestrated review. `auto` reviews each PR when opened; `/review` is always available.                                                                                                                                                  |
| `FEATURE_DESCRIBE`      | `off` \| `manual` \| `auto`        | `auto`   | yes            | PR description generation. `auto` runs when a PR opens; `/describe` re-runs on demand.                                                                                                                                                   |
| `FEATURE_VERIFICATION`  | `off` \| `manual` \| `auto`        | `auto`   | yes            | Re-checks open findings on synchronize or on-demand `/verify`. Silently resolves fixed threads and edits stubs. Terminal failure edits the CI cell or one stub line.                                                                     |
| `FEATURE_ASK`           | `off` \| `manual`                  | `manual` | yes            | `/ask` and App-bot mention question threads.                                                                                                                                                                                             |
| `FEATURE_TRIAGE`        | `off` \| `manual`                  | `manual` | yes            | `/triage` autofix plus `/triage preview` then `/triage all` (preview required before bulk).                                                                                                                                              |
| `FEATURE_REVIEW_LABELS` | `off` \| `size` \| `size+security` | `size`   | no             | Size and security labels. `off` still syncs `Category: bug\|security\|performance\|style` when a finding has a category or a managed category label already exists.                                                                      |
| `FEATURE_COMMIT_STATUS` | `false` \| `true`                  | `false`  | no             | Posts `pr-agent/review` on the PR head. `pending` when the check starts. `success` or `failure` from published findings. `error` on cancel, supersede, stale head, crash, unpublished, or partial coverage. Usable in branch protection. |
| `FEATURE_TITLE_REWRITE` | `false` \| `true`                  | `true`   | no             | Allows `/describe` to rewrite the PR title using make-pr default title rules (imperative sentence case, no type prefix, no trailing period, at most 60 characters). Set `false` to keep the existing title.                              |

Notes:

- `FEATURE_REVIEW` has no `off`: review is the product; `/review` always works.
- Describe, verification, ask, and triage can be turned `off` to stop those
  surfaces from spending tokens at all. Default `FEATURE_VERIFICATION=auto`
  spends tokens on every `synchronize` push.
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
