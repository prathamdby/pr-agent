# ADR 0017: Full-context local PR workspace

## Status

Accepted. Supersedes the changed-file materialization and local-git diff authority parts of [ADR 0015](0015-agent-runner-local-pr-workspace.md).

## Context

ADR 0015 introduced a **Local PR workspace** with a private git object database and an agent-visible tree that initially contained only changed files materialized from `git show`. Agents could lazy-read other paths, but investigation still leaned on a partial tree and local `git diff` for changed paths and inline anchor hints.

That layout made it easy to miss surrounding callers, shared types, and config when the PR diff alone was insufficient. A depth-1 fetch of the full PR head is fast enough to expose the whole git-tracked tree while keeping `.git`, credentials, and hooks outside the sandbox.

## Decision

1. **Full head checkout** — After durable head-SHA resolution, prepare a shallow (`--depth=1`), no-tags, no-submodules checkout of `refs/pull/<n>/head` into the agent-visible tree via a private git directory (`GIT_WORK_TREE`). Full mode uses eager blobs. Sparse mode, used only above the configured repo-size cap, adds `--filter=blob:none` and materializes the sparse changed-file checkout before credentials are removed.
2. **GitHub PR files for diff metadata** — Changed paths, unified diff patches (subject to existing caps), and commentable RIGHT-side anchor ranges come from `pulls.listFiles` via shared [`src/github/listPullRequestFiles.ts`](../../src/github/listPullRequestFiles.ts), not local `git diff base...head`.
3. **PR-scoped findings** — The full tree is context for investigation; review findings remain tied to issues introduced or exposed by the PR. Publish-time inline anchors still use the server diff index.
4. **Search budgets** — `searchWorkspace` uses `git grep` over ask-gated path chunks. `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES` caps git-grep stdout before returning a truncated result; `LOCAL_WORKSPACE_SEARCH_MAX_FILES` is retained as a legacy JS-scan knob. Single-file reads remain capped by `LOCAL_WORKSPACE_MAX_FILE_BYTES`.
5. **Security** — Committed sensitive-looking files remain in the checkout (no redaction). `.git`, token files, askpass, hooks, and symlinks stay out of or are removed from the agent tree. Ask sensitive-path gates still apply to local tool reads.

## Consequences

- Worker disk and network per run increase versus changed-file-only materialization; mitigated by depth-1 fetch and existing free-space checks.
- Sparse mode reduces network transfer for large repositories, but it deliberately keeps only changed-file paths in the checkout. Any blobs needed by the sparse checkout must materialize before the askpass and token files are removed.
- One additional GitHub API call per workspace prepare (`listFiles`); investigation no longer depends on merge-base history in the private git dir.
- `LOCAL_WORKSPACE_MAX_MATERIALIZED_FILES` and `LOCAL_WORKSPACE_MAX_TOTAL_BYTES` are removed; deployments must adopt the new search env names.
- Tests must assert full-tree presence and PR-metadata-driven diff index separately from git checkout.

## Amendment (2026-07-26): checkout coverage honesty

Sparse checkout and truncated change sets or searches must be advertised in trusted
context, tool refusals, and metadata-only `coverage` agent events so agents and
operators cannot mistake partial disk coverage for full-repo certainty.

## Alternatives considered

- **Keep changed-file-only materialization** — Rejected; does not meet the full-context goal.
- **Local git diff as authority** — Rejected for anchors; depth-1 head fetch does not guarantee merge-base reachability without extra history.
- **Partial clone (`--filter=blob:none`)** — Rejected for full mode; lazy blobs weaken immediate full-context reads. Accepted for sparse mode because sparse checkout already gives up full-tree reads and only needs changed-path blobs materialized before credential cleanup.
- **Omit sensitive paths from checkout** — Rejected; would hide config the agent may need; documented trade-off instead.
