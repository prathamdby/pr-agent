# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

Do not open a pull request. Sandcastle merges completed branches later.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# PLAN REVIEW

Before implementation, review the issue requirements, relevant code, and your implementation plan. Fix the critical risk in the plan before writing code. If the plan needs rework, rework it before implementation.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, run `pnpm run check:code` and `pnpm run test`.

# CLEANUP AND COMMIT

Before committing, clean the working-tree changes. Preserve exact behavior while removing AI artifacts, bloat, and unnecessary complexity.

Stage your changes, then commit with the inlined Sandcastle commit rules below.

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

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
