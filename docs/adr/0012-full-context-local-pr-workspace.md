# ADR 0012: Full-context local PR workspace

## Status

Accepted. Supersedes the earlier changed-file-only materialization and local-git diff authority. Read-only investigation and workspace resource ownership remain in [ADR 0011](0011-agent-runner-local-pr-workspace.md).

## Context

The first **Local PR workspace** used a private git object database and an agent-visible tree that contained only changed files materialized from `git show`. Agents could lazy-read other paths, but investigation still leaned on a partial tree and local `git diff` for changed paths and inline anchor hints.

That layout made it easy to miss surrounding callers, shared types, and config when the PR diff alone was insufficient. A depth-1 fetch of the full PR head is fast enough to expose the whole git-tracked tree while keeping `.git`, credentials, and hooks outside the sandbox.

## Decision

1. **Full head checkout** — After durable head-SHA resolution, prepare a shallow (`--depth=1`), no-tags, no-submodules checkout of `refs/pull/<n>/head` into the agent-visible tree via a private git directory (`GIT_WORK_TREE`). Full mode uses eager blobs. Sparse mode, used only above the configured repo-size cap, adds `--filter=blob:none` and materializes the sparse changed-file checkout before credentials are removed.
2. **GitHub PR files for diff metadata** — Changed paths, unified diff patches (subject to existing caps), and commentable RIGHT-side anchor ranges come from `pulls.listFiles` via shared [`src/github/listPullRequestFiles.ts`](../../src/github/listPullRequestFiles.ts), not local `git diff base...head`.
3. **PR-scoped findings** — The full tree is context for investigation; review findings remain tied to issues introduced or exposed by the PR. Publish-time inline anchors still use the server diff index.
4. **Search budgets** — Superseded for pinned checkouts by [ADR 0048](0048-fff-workspace-search.md). `searchWorkspace` uses literal `git grep -nF -I -z` over ask-gated path chunks. It does not pass `--max-count` (Git 2.40+). `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES` caps git-grep stdout before returning a truncated result; the tool's `maxResults` caps returned matches after parse. `LOCAL_WORKSPACE_SEARCH_MAX_FILES` is retained as a legacy JS-scan knob. Single-file reads remain capped by `LOCAL_WORKSPACE_MAX_FILE_BYTES`.
5. **Security** — Committed sensitive-looking files remain in the checkout (no redaction). `.git`, token files, askpass, hooks, and symlinks stay out of or are removed from the agent tree. Ask sensitive-path gates still apply to local tool reads.

## Consequences

- Worker disk and network per run increase versus changed-file-only materialization; mitigated by depth-1 fetch and existing free-space checks.
- Sparse mode reduces network transfer for large repositories, but it deliberately keeps only changed-file paths in the checkout. Any blobs needed by the sparse checkout must materialize before the askpass and token files are removed.
- One additional GitHub API call per workspace prepare (`listFiles`); investigation no longer depends on merge-base history in the private git dir.
- `LOCAL_WORKSPACE_MAX_MATERIALIZED_FILES` and `LOCAL_WORKSPACE_MAX_TOTAL_BYTES` are removed; deployments must adopt the new search env names.
- Tests must assert full-tree presence and PR-metadata-driven diff index separately from git checkout.

## Amendment (2026-09-05): Git 2.39 search

Shared workspace search must run on the application image Git (Debian bookworm 2.39.x). Result and stdout caps stay in the workspace after grep returns. This does not change checkout coverage or GitHub PR diff authority.

## Amendment (2026-07-26): checkout coverage honesty

Sparse checkout and truncated change sets or searches must be advertised in trusted
context, tool refusals, and metadata-only `coverage` agent events so agents and
operators cannot mistake partial disk coverage for full-repo certainty.

## Amendment (2026-10-17): fetch failure modes

Workspace Git runs in its own process group with stdin closed, `LC_ALL=C`, and
a bounded output buffer (`src/prWorkspace/gitProcess.ts`). A deadline or output
cap sends SIGTERM to the group, waits `LOCAL_WORKSPACE_GIT_KILL_GRACE_MS`, sends
SIGKILL, and confirms the group is gone within `LOCAL_WORKSPACE_GIT_KILL_CONFIRM_MS`.
A descendant that keeps the pipes open after its leader exits is ended the same
way. Cleanup that cannot be confirmed reports `cleanup: failed`.

Fetch sets `http.lowSpeedLimit` and `http.lowSpeedTime`, so Git exits on its own
when a transfer stalls (`timeoutSource: git_low_speed`) before the process
deadline (`process_timer`).

Failures are closed codes. `pr_workspace.fetch_timeout` means the process timer
fired on a fetch. Every other Git failure is `pr_workspace.git_failed`. The
context carries the operation, checkout mode, elapsed time, exit code, signal,
`killed`, timeout source, failure kind (`timeout`, `auth`, `missing_ref`, or
`git`), cleanup result, and a stderr tail of at most 1,000 characters. Redaction
of the installation token, credential URLs, and outbound secret patterns runs on
the whole stderr before classification and before the cut. The error carries no
raw cause. Auth and missing-ref failures are terminal. Other Git failures stay
transient.

A full checkout whose fetch times out, stalls, or fails with a generic Git error
retries once in the same attempt as a sparse checkout (`--filter=blob:none`),
after recreating the private and agent directories. Auth, missing ref, spawn
failures, and unconfirmed cleanup do not fall back. A sparse checkout never
falls back. When the fallback also fails, the sparse error is primary and
`context.fallback` holds the full attempt. A fallback checkout reports sparse
coverage under the coverage honesty amendment. `LocalPrWorkspace.checkoutTelemetry`
records the mode (`full`, `sparse`, or `sparse_fallback`), the fallback reason,
and at most two fetch attempts.

Failure modes recorded before implementation: a silent server holds the fetch
until the deadline; a TERM-ignoring descendant outlives its leader; the deadline
races process exit; a spawn fails; a secret is split across stderr chunks or the
diagnostic cut; an output cap cuts a line; auth or missing-ref failures spend
retries or start a useless fallback; a failed fallback hides the original
timeout; telemetry is lost for a cached workspace or a failed checkout.

Repeat the workspace-fetch proof: `PR_AGENT_WORKSPACE_FETCH_PROOF=verify-artifacts/workspace-fetch-proof.json PR_AGENT_GIT_LOW_SPEED_PROBE=1 npm run test -- test/localPrWorkspace.test.ts`
writes the attempts, the execution span, and the process-tree result.

## Alternatives considered

- **Keep changed-file-only materialization** — Rejected; does not meet the full-context goal.
- **Local git diff as authority** — Rejected for anchors; depth-1 head fetch does not guarantee merge-base reachability without extra history.
- **Partial clone (`--filter=blob:none`)** — Rejected for full mode; lazy blobs weaken immediate full-context reads. Accepted for sparse mode because sparse checkout already gives up full-tree reads and only needs changed-path blobs materialized before credential cleanup.
- **Omit sensitive paths from checkout** — Rejected; would hide config the agent may need; documented trade-off instead.
