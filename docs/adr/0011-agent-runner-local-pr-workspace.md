# ADR 0011: Read-only local PR workspace investigation

## Status

Accepted for read-only investigation tools, workspace resource ownership, and stale-head reschedule. Pi is the only agent runtime ([ADR 0023](0023-pi-native-agent-runtime.md)). Full-head checkout and GitHub `listFiles` diff authority are defined in [ADR 0012](0012-full-context-local-pr-workspace.md).

## Context

Review and ask runs used to expose GitHub read tools to the agent. That kept the worker stateless with respect to target repositories, but it also pushed file discovery and content reads through GitHub APIs and prompt context.

The service still needs durable intake, worker-owned publishing, progress comments, publish idempotency, and public-output sanitization.

## Decision

1. Agents are read-only investigators. Production runs expose local read/search/diff tools, Context7 tools, and structured submit/publish tools. No write or shell tools are enabled on review, ask, description, or verification sessions.
2. GitHub read tools are not on the agent-callable investigation surface. A trusted `pulls.get` / `listFiles` read at job start is still allowed for PR identity, head/base SHAs, fork state, title/body, repository URLs, and the cached diff. Publish/idempotency reads and a final head check remain server-owned.
3. Each review, ask, description, or verification run prepares a **Local PR workspace** in the worker after durable head-SHA resolution. Temp-root allocation, credential files, and release are owned by one `WorkspaceResource`. An on-disk ownership marker plus heartbeat is the sweep safety guarantee so one worker cannot delete another process's live checkout.
4. Auto and slash-command reviews get one stale-head reschedule. If a review reaches publish after the PR head has changed, the worker may schedule one replacement run for the latest head (preserving slash command context when present). If the replacement also goes stale, it fails with retry guidance instead of rescheduling indefinitely.

## Consequences

- Worker runtime depends on `git`, disk-space admission checks, stale workspace cleanup, and per-run workspace cleanup.
- GitHub API rate-limit pressure moves out of investigation and remains only around trusted metadata and publish/idempotency operations.
- Pi coding-agent must use in-memory or temp per-run storage in production workers; workers must not write default `~/.pi` state.

## Alternatives considered

- Keep GitHub read tools and only add local file access. Rejected because the target architecture removes GitHub reads from the agent investigation surface.
- Remove all GitHub reads. Rejected because PR metadata, final head checks, and publish idempotency still require trusted GitHub state.
- Allow agents to see `.git` and run shell commands. Rejected because review jobs are read-only and PR code is untrusted.
