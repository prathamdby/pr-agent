# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run `pnpm run check:code` and `pnpm run test`
4. If checks fail, fix the issues before proceeding to the next branch

After all branches are merged, stage and make a single commit with the inlined Sandcastle commit rules below.

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

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`gh issue close <ID> --comment "Completed by Sandcastle"`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
