# Spec: entire-codebase cleanup

## Goal

Review and clean the entire production and test surface so the tree is free of AI slop, useless one-caller helpers, and over-engineering.

## Requirements

1. Apply Fowler smell baseline across `src/`, `test/`, and `site/` (not only a PR diff).
2. Remove or inline useless single-use functions and Middle Man wrappers when inlining lowers reader load.
3. Delete Speculative Generality: unused abstractions, unused params, speculative hooks, dead re-exports.
4. Remove AI slop: narrating comments, redundant JSDoc that restates the signature, chatbot phrasing in comments.
5. Fix hard violations of `docs/development.md` (no bare `Error` from `src/`, no forbidden barrel imports, AppError rules).
6. Prefer deletion and inlining over new shared abstractions unless duplication is already real and painful.
7. Keep behavior unchanged. Pin with `nub run test`, `nubx knip`, and `nub run check:code`.
8. Ship fixes on `pd/chore/knip-deslop-15a1` (PR #331).

## Non-goals

- Do not invent new product features.
- Do not rewrite prompt product-copy strings solely to remove em dashes.
- Do not extract new shared helpers for one-off sleep/escape clones unless a clear third caller already exists.
