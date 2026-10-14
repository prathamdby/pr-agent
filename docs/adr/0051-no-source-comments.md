# ADR 0051: No source comments

## Status

Accepted. Replaces the "comments explain why" rule in `AGENTS.md` and retires
`scripts/check-comments.mjs`.

## Context

The repository allowed comments that explain a non-obvious constraint and used
`scripts/check-comments.mjs` to reject a few narration markers. The marker list
could not tell a useful comment from a stale one, and comments drifted from the
code they described. Names, types, guard rows, tests, and ADRs already carry the
constraints that matter, and the guard ledger locks them.

## Decision

1. Linted source (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`) carries no comments. The
   local oxlint JS plugin rule `pr-agent/no-comments` (`scripts/lint/no-comments.mjs`)
   reports every comment and fixes it with `oxlint --fix`.
2. Two machine directives stay, because tools read them:
   - `// oxlint-disable-next-line <rule> -- <reason>`. The `lint-suppressions(src)`
     and `lint-suppressions(test)` ledger rows keep counting them.
   - `/// <reference ... />`.
3. Generated files are added to oxlint `ignorePatterns` instead of being edited.
   `site/routeTree.gen.ts` is the current one.
4. The guard counters build their temporary oxlint config through
   `scripts/forcedOxlintConfig.mjs`, which drops `jsPlugins` and `pr-agent/*` rules.
   The ledger runs that config in the merge-base tree, where the plugin may not
   exist, and no counted row targets the plugin.
5. `scripts/check-comments.mjs` is deleted. Its markers only matched comments, and
   the rule now rejects every comment.
6. A constraint that a comment used to explain moves into a name, a type, a guard
   row, a test, or an ADR.

### Failure modes

The owner test in `test/architectureRules.test.ts` covers each of these:

1. The plugin does not load or the rule is not enabled, so comments pass lint.
2. A comment kind is missed: line, block, JSDoc, trailing, or JSX `{/* */}`.
3. Text inside strings, template literals, or regular expressions that looks
   like `//` or `/*` is reported.
4. The exemptions are too wide: a file-wide `/* oxlint-disable */`, an
   `eslint-disable` line, a suppression without `-- <reason>`, or
   `@ts-expect-error` passes.
5. The exemptions are too narrow: a valid suppression or reference directive is
   reported or removed by the fix.
6. The fix changes behaviour: removing a block comment that holds a line break
   joins `return` to the next line.
7. The fix leaves an empty JSX expression container `{}` behind.

## Consequences

- Reviewers read intent from names, types, and the linked ADRs and runbooks.
- JS plugins are alpha in oxlint and not covered by semver. The oxlint version stays
  pinned exactly, and every oxlint bump reruns the owner test.
- Comments in SQL, YAML, Dockerfile, shell, CSS, and Markdown are out of scope,
  because oxlint does not lint them.
