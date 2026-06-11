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
3. Stage and commit with the inlined Sandcastle commit rules below

# COMMIT RULES

- Use the staged diff only. Run `git diff --cached | cat`.
- If the staged diff is empty, do not commit.
- Ignore issue text, PRD prose, session context, and review discussion when writing the message.
- Use conventional format. The subject is `type: description`.
- Allowed types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, and `perf`.
- Do not use scope notation. Write `feat: add auth flow`, not `feat(auth): add auth flow`.
- Keep the subject at 50 characters or less. Use lowercase except proper nouns and technical terms. Do not end with a period.
- Add a body only when the diff needs more explanation than the subject. Body lines are `-` bullets. Capitalize the first word. Do not end bullets with periods. Do not put blank lines between bullets.
- Use one or two `-m` flags. The first `-m` is the subject. The optional second `-m` is the whole body.
- Do not use three or more `-m` flags.
- Default hook behavior is skipped. Run `git commit -n -m "<subject>"`.
- With a body, run `git commit -n -m "<subject>" -m $'- First bullet\n- Second bullet'`.
- Never run `git commit` without `-n` unless this prompt explicitly asks for `--verify`.
- Do not write messages like "address review feedback", "implement the plan", or "update per request". Describe the concrete diff.

If the code is already clean and well-structured, do nothing.

Once complete, output <promise>COMPLETE</promise>.
