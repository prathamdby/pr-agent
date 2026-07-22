# Plan: knip cleanup and AI slop removal

## Goal

Run `nubx knip`, clear every finding, remove AI slop traces, leave knip green and tests unchanged.

## Requirements

1. Knip reports zero issues with a committed `knip.json` that includes root and `site` workspaces.
2. Delete or unexport unused symbols; remove unused `@octokit/request-error`.
3. Wire `IGNORED_*` slash constants into webhook intake instead of string literals.
4. Update `docs/configuration.md` for deleted settings symbols.
5. Remove narrating or redundant comments found in the slop scan.
6. Pin: existing unit suite stays green (`nub run test`).

## Steps

1. Add workspace-aware `knip.json` so the landing site is not false-positive unused.
2. Subtract dead exports, dead prompt blocks, unused deps; unexport file-local APIs.
3. Use queue ignore constants at the webhook gate.
4. Deslop high-confidence comment noise.
5. Verify with `nubx knip`, `nub run check:code`, `nub run test`.

## Non-goals

- No behavior changes to review, ask, triage, or publish paths.
- No rewrite of established product-copy em dashes in prompts or GitHub status strings.
