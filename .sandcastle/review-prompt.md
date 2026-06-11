# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality.

Do not open a pull request. Sandcastle merges branches after review.

# CONTEXT

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. Review the branch diff, commits, issue context you can fetch, and relevant source files. Focus on the critical risk first.
2. If you find a correctness, security, or test gap, make the smallest fix that addresses the critical risk.
3. Remove AI artifacts, bloat, redundant abstractions, and unclear code while preserving exact behavior.
4. Apply the project standards in @.sandcastle/CODING_STANDARDS.md.
5. Preserve functionality. All original features, outputs, and behaviors must remain intact.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on this branch
2. Run `pnpm run check:code` and `pnpm run test`
3. Stage and commit with the commit rules below

If the code is already clean and well-structured, do nothing.

Once complete, output <promise>COMPLETE</promise>.

# COMMIT RULES

- Diff only. Ignore session context, issues, and PRD prose.
- Conventional format: `type: description`. No scopes. Max 50 chars. Lowercase. No period.
- Body only when needed: `-` bullets, capitalized, no periods, no blank lines.
- One or two `-m` flags only. Never three+.
- Skip hooks: `git commit -n -m "..."`. With body: `git commit -n -m "..." -m $'- ...\n- ...'`.
- Never run without `-n` unless explicitly asked for `--verify`.
- Never write "address review feedback", "implement the plan", or "update per request". Describe the concrete diff.
