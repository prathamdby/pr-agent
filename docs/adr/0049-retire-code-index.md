# ADR 0049: Retire the code index

## Status

Accepted. Supersedes item 5 of
[ADR 0024](0024-workspace-primary-grounding-and-evidence.md). Items 1 to 4 stand:
the workspace at `headSha` is still the only publishable code authority.

## Context

The optional Postgres FTS code index (`CODE_INDEX_MODE=fts`, default `off`)
chunked a repository into `code_index_chunks`, built snapshots on the
`code-index-build` queue, and exposed native `searchCodeIndex` to review
specialists, the orchestrator, and ask. Most installs never turned it on, so most
reviews saw `{ unavailable: true }`. When it was on, it stored repository text in
Postgres and needed a build, a wait, and retention.

[ADR 0048](0048-fff-workspace-search.md) put an in-memory fff index behind
workspace search. Probes showed that fff's fuzzy grep is no substitute for
`plainto_tsquery` (it matches line by line and in order), but the jobs the index
served are covered by two workspace tools on the live checkout.

## Decision

1. Remove `searchCodeIndex`, `src/codeIndex/`, its build consumer, its
   retention, the `CODE_INDEX_*` settings, and the `code_index` error domain.
2. `searchWorkspace` takes optional `terms`. Each literal (query plus terms)
   searches the checkout, and files rank by how many distinct literals they
   contain, then by matched lines. The response lists ranked `files` and orders
   `matches` the same way. This replaces concept search with literal terms the
   model chooses. English stemming is dropped.
3. New `findFiles` does fuzzy, case-insensitive path lookup. fff ranks the paths
   it indexes. Paths it does not index, and every path when the host is down,
   use a deterministic basename, path, then subsequence ranking.
4. Boot deletes the `code-index-build` queue, including leftover jobs, because
   they only rebuilt the index. Boot logs `config_removed_env_ignored` when a
   removed `CODE_INDEX_*` setting is still set.
5. The review recovery binding keeps `codeIndexMode: "off"`, so existing
   validated review artifacts keep their hash.
6. Tables `code_index_snapshots` and `code_index_chunks` stay one more release, so
   a rollback to the previous release still boots. A later migration drops them.

## Consequences

- Repository text is no longer written to Postgres. Rows already written stay
  until the drop migration; nothing reads or prunes them meanwhile.
- The native tool list shrinks for review and ask, and the Code Mode catalogue
  gains `findFiles`. The prompt cache prefix changes once.
- Rollback to the previous release works until the drop migration ships. After
  that, `CODE_INDEX_MODE=fts` on an old release fails its builds.
- Upgrade web and worker together. An old worker still consumes the deleted
  queue until it stops.
