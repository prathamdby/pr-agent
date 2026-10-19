# Ship

## Verify the real path

Start with the smallest check that proves the changed contract, then run the repository gate before pushing. Read the actual output and inspect the final diff. A passing typecheck alone does not prove webhook intake, queue recovery, or GitHub publishing.

Default to end-to-end or integration proof with a verifiable artifact. For durable work, webhooks, or database paths, run the integration suite as well as the backend gate. For prompt, policy, or output changes, inspect the generated prompt, published record, or other repeatable runtime output; do not add post-hoc unit tests or treat seam tests as the default substitute. Record any unavailable external dependency instead of treating an unrun check as a pass.

When test changes are already in scope, keep them proportional to the changed contract and aligned with the testing policy in [AGENTS.md](../AGENTS.md). Do not strengthen coverage by adding low-signal unit tests after the fact. Separate an environment or toolchain failure from a repository failure, and record the evidence for that distinction.

## Pull requests

- Open a PR only when the developer asks for one.
- Keep one concern per PR. Split unrelated cleanup.
- Before filing, fetch `origin`, check whether the branch already has an open PR, inspect the complete diff against `origin/main`, and exclude unrelated worktree changes.
- Write the title and body from the final diff. Open with the user-visible problem and solution, then name affected contracts and checks that actually ran.
- Preserve the repository vocabulary.
