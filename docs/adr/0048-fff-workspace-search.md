# ADR 0048: fff workspace search

## Status

Accepted. Supersedes item 4 of [ADR 0012](0012-full-context-local-pr-workspace.md)
for pinned checkouts. Writable triage checkouts still search with `git grep`.

## Context

`searchWorkspace` ran one `git grep -nF -I -z` process per call. Review
specialists, the orchestrator, ask, description, and verification call it many
times against the same immutable checkout. [fff](https://github.com/dmtrKovalenko/fff)
keeps an in-memory index of a tree and answers literal multi-pattern searches
from it.

A peer review of the first plan, with probes against `@ff-labs/fff-node@0.11.0`,
found that fff is not a drop-in `git grep`:

- Calls are synchronous FFI on the caller's thread through `ffi-rs`. Grepping a
  file, shrinking it, and grepping again ends the process with SIGBUS. A Rust
  panic aborts the process.
- Our pinned checkouts keep the git directory outside `agentCwd`, so fff treats
  the tree as non-git. It then skips dotfiles and well-known ignored directories,
  and it always honors `.gitignore` and `.ignore`. A pull request can add an
  `.ignore` file.
- `grep(query)` parses tokens such as `*.ts`, `src/`, and `!x` into filters.
  `smartCase` defaults to on.
- Files above `maxFileSize` and files with binary-looking extensions are skipped
  without reading them. Line text is cut at 512 bytes and loses `\r`.
- A search during the initial scan returns an empty success.

## Decision

1. **Separate process.** `src/prWorkspace/fff/host.ts` is the only importer of
   `@ff-labs/fff-node` (guard row `scripts/guards/fff.json`). The worker forks it
   lazily on the first pinned search, with an empty environment, and talks to it
   over IPC. Each request has a deadline (`LOCAL_WORKSPACE_FFF_CALL_TIMEOUT_MS`).
   A deadline miss, exit, or send error kills the host and fails its pending
   requests. The next host spawns after `LOCAL_WORKSPACE_FFF_RESPAWN_BACKOFF_MS`.
   The web role never searches, so it never spawns the host.
2. **Index per pinned checkout.** The reader opens one `FileFinder` with
   `disableWatch`, waits for the scan, and lists the indexed files. A scan that
   does not finish in `LOCAL_WORKSPACE_FFF_SCAN_TIMEOUT_MS` fails the open.
   Trees above `LOCAL_WORKSPACE_FFF_MAX_INDEXED_FILES` skip fff. The host keeps at
   most `LOCAL_WORKSPACE_FFF_MAX_LIVE_INDEXES` finders and evicts the least
   recently used. Reader dispose closes the index.
3. **Exact coverage.** fff answers only for tracked checkout paths it indexed,
   below `LOCAL_WORKSPACE_FFF_MAX_FILE_BYTES`, without a skipped extension. Every
   other allowed path goes to `git grep` in the same call. Paths the caller's
   policy blocks, and untracked indexed paths, are dropped inside the host before
   results cross IPC. `filtered` stays a path-policy fact, never a content one.
4. **Literal semantics.** Searches use `multiGrep` with one pattern, no
   constraints, and `smartCase: false`. Queries with a newline or NUL stay on
   `git grep`. The host returns paths, line numbers, and validated line-start
   byte offsets. The reader merges those descriptors with Git results in
   checkout path order, then line, before materializing the selected prefix.
   It seeks to each selected line and reads through LF or EOF in chunks of at
   most 64 KiB, preserving `\r`, UTF-8, and full line text. Nearby hits reuse the
   current chunk; only one file handle stays open per search. Whole-file text
   and split-line arrays are not retained.
   Pinned searches cap `maxResults` at `LOCAL_WORKSPACE_SEARCH_MAX_MATCHES`
   (200), including ranked results and whole-call Git fallback. The existing
   `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES` ceiling applies while lines are
   read. A line that cannot fit stops the result prefix with `truncated: true`,
   without returning a clipped fff line or reading later candidates.
5. **Fallback.** Any open or grep failure, including a host crash or the paging
   budget `LOCAL_WORKSPACE_FFF_GREP_TIME_BUDGET_MS`, logs
   `workspace_search_fff_fallback` (stage and reason, never the query) and runs
   the whole call through `git grep`. Invalid hit paths, offsets, or failed
   line reads also fall back once, with a fixed reason and no query text.
   Budget exhaustion returns truncated output instead of retrying.
   A host death is logged as
   `workspace_search_fff_host_retired`.

## Consequences

- A native crash ends only the host. Leased jobs, lease renewal, and other
  searches keep running.
- `git grep` stays in the image and remains the triage engine, the coverage net,
  and the fallback.
- The image carries `@ff-labs/fff-node`, its platform package
  (`@ff-labs/fff-bin-linux-x64-gnu` is 11.2MB and needs glibc 2.30), and `ffi-rs`.
  Backend production installation retains the platform packages.
- fff is pre-1.0. The dependency is pinned to an exact version, and the skipped
  extension list in `src/prWorkspace/fff/workspaceSearch.ts` mirrors that version.
  Re-check both on every bump.
- Memory: about 160MB RSS per large tree in probes. Default concurrency allows six
  live indexes in one host.
