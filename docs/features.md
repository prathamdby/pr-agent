# Features

The eight `FEATURE_*` settings are pr-agent's entire user-facing configuration.
Everything else is deployment wiring or operator tuning (see
[configuration.md](configuration.md)).

Modes: `off` = disabled entirely (slash commands reply with a notice, nothing
runs), `manual` = slash command only, `auto` = slash command plus an automatic
trigger. Auto triggers are fixed: review and describe fire when a PR is
`opened`; verification fires on `synchronize` (every push). Custom trigger
sets are intentionally not supported.

| Setting                 | Values                             | Default  | Spends tokens? | What it does                                                                                 |
| ----------------------- | ---------------------------------- | -------- | -------------- | -------------------------------------------------------------------------------------------- |
| `FEATURE_REVIEW`        | `manual` \| `auto`                 | `auto`   | yes            | Orchestrated review. `auto` reviews each PR when opened; `/review` is always available.      |
| `FEATURE_DESCRIBE`      | `off` \| `manual` \| `auto`        | `auto`   | yes            | PR description generation. `auto` runs when a PR opens; `/describe` re-runs on demand.       |
| `FEATURE_VERIFICATION`  | `off` \| `auto`                    | `auto`   | yes            | Re-checks open findings against new pushes and replies in their threads.                     |
| `FEATURE_ASK`           | `off` \| `manual`                  | `manual` | yes            | `/ask` and `@bot` question threads.                                                          |
| `FEATURE_TRIAGE`        | `off` \| `manual`                  | `manual` | yes            | `/triage` autofix: checkout, commit, and push fixes for open bot findings.                   |
| `FEATURE_REVIEW_LABELS` | `off` \| `size` \| `size+security` | `size`   | no             | Review size / security labels synced onto the PR.                                            |
| `FEATURE_COMMIT_STATUS` | `false` \| `true`                  | `false`  | no             | Posts the `pr-agent/review` commit status on the PR head; usable in branch protection rules. |
| `FEATURE_TITLE_REWRITE` | `false` \| `true`                  | `false`  | no             | Allows `/describe` to rewrite the PR title.                                                  |

Notes:

- `FEATURE_REVIEW` has no `off`: review is the product; `/review` always works.
- Describe, verification, ask, and triage can be turned `off` to stop those
  surfaces from spending tokens at all.
- Invalid values fail startup with the allowed list; typos never silently
  disable a feature.
- Pre-revision variables (`ENABLE_*`, `*_AUTO_ACTIONS`,
  `DESCRIPTION_GENERATE_TITLE`, and the old tuning knobs) are ignored; use
  `FEATURE_*` only. There are no aliases.

Defaults reproduce the pre-revision out-of-the-box behavior exactly.
CI enforces that every `FEATURE_*` key is documented here
([`test/settingsInventory.test.ts`](../test/settingsInventory.test.ts)).
