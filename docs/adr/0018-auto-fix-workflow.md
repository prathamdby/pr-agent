# ADR 0018: Auto-fix workflow

## Status

Accepted.

## Context

Review findings already carry per-finding fix prompts, but asking an external coding agent to fix them by copy-paste loses server control over authorization, git state, stale heads, and publish behavior.

Auto-fix is write-capable. It needs stricter boundaries than review, ask, and description runs.

## Decision

Add `fix` as a durable agent work type triggered by:

- `/fix` on a reply to a persisted PR Agent inline finding.
- `/fix-all` in the PR conversation.

Webhook intake stays non-blocking. It records work, schedules the acknowledgement reaction, and returns. Workers perform GitHub reads, authorization, target resolution, agent execution, commits, pushes, fallback PR creation, and final replies.

Successful review publishes persist auto-fix bundles and P0 to P2 targets. `/fix` resolves the target from the original inline review comment id. `/fix-all` selects the latest completed bundle for each review lens when the worker runs.

The command issuer must have `write`, `maintain`, or `admin` on the base repository.

## Write Boundary

The provider-visible cwd is a temporary scratch directory with no PR tree and no `.git`. The server owns a separate writable checkout at the current PR head.

Agents get provider-neutral tools only:

- `listFixChangedFiles`
- `readFixFile`
- `searchFixWorkspace`
- `getFixPrDiff`
- `editFixFile`
- `writeFixFile`
- `deleteFixPath`
- `getFixWorktreeDiff`
- `submitAutoFixResult`

The server validates paths, refuses traversal and symlink paths, runs `git diff --check`, creates commits, and pushes. Provider-native file writes in scratch space are ignored.

For Cursor runs, local settings are disabled and sandboxing is requested with `sandboxOptions.enabled = true`. If Cursor cannot create the sandboxed local agent, the run fails instead of falling back to an unsandboxed fix run.

For Pi runs, built-ins remain disabled by the existing custom-tool runner path.

## Git Publishing

Each target group runs sequentially. `/fix-all` groups same-file overlapping ranges. Each group that produces a server-visible diff becomes one commit authored and committed as the GitHub App bot.

The worker checks the PR head before publishing. If the head moved during the run, it publishes no commits and replies stale.

The worker first tries to push commits to the PR head branch. If that push is denied while the head is unchanged, it pushes a deterministic branch in the base repository and creates or reuses one replacement PR for the work item.

Auto-fix does not edit review summaries or resolve review threads.

## Consequences

The server remains the write boundary for git and GitHub mutation. Provider behavior can vary, but final diffs are limited to server-tool mutations.

Auto-fix requires GitHub App **Contents read/write** permission.

No tests or build commands run in v1. The only validation before commit is server-owned `git diff --check`.
