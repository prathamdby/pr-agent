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

Stage your changes, then commit with the commit rules below.

# COMMIT RULES

- Diff only. Ignore session context, issues, and PRD prose.
- Conventional format: `type: description`. No scopes. Max 50 chars. Lowercase. No period.
- Body only when needed: `-` bullets, capitalized, no periods, no blank lines.
- One or two `-m` flags only. Never three+.
- Skip hooks: `git commit -n -m "..."`. With body: `git commit -n -m "..." -m $'- ...\n- ...'`.
- Never run without `-n` unless explicitly asked for `--verify`.
- Never write "address review feedback", "implement the plan", or "update per request". Describe the concrete diff.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
