# ADR 0015: Agent runner providers and local PR workspace

## Status

Accepted. Supersedes the GitHub-API-only repository signal and `PI_PROVIDER=cursor`
selection parts of [ADR 0013](0013-cursor-sdk-provider.md).

## Context

Review and ask runs currently expose GitHub read tools to the agent. That keeps the
worker stateless with respect to target repositories, but it also pushes changed-file
discovery, file content reads, and inline anchor hints through GitHub APIs and prompt
context. Cursor support is also wired through `pi-ai` as a provider adapter even though
Cursor and Pi coding-agent are different runner surfaces.

The service still needs durable intake, worker-owned publishing, progress comments,
publish idempotency, public-output sanitization, and `submitReview` as the only
structured publish path.

## Decision

1. Add `AGENT_PROVIDER` as the runner axis. `AGENT_PROVIDER=pi` uses Pi coding-agent;
   `AGENT_PROVIDER=cursor` uses the Cursor SDK. `PI_PROVIDER` and `PI_MODEL` remain
   model-selection inputs for the Pi runner, and `PI_MODEL` is also the Cursor model id.
2. The runner seam is server-controlled and multi-turn. The review/ask harness can send
   initial prompts, validation-repair prompts, publish-recovery prompts, and ask
   finalization prompts through either runner.
3. Agents are read-only investigators. Production runs expose local read/search/diff
   tools, Context7 tools, and `submitReview`; no write or shell tools are enabled.
4. Each review or ask run prepares a **Local PR workspace** in the worker after durable
   head-SHA resolution. The workspace has a private git checkout for server-owned
   diff/blame operations and a separate sanitized agent-visible tree with no `.git`,
   hooks, credentials, or symlinks.
5. GitHub read tools are removed from the agent-callable investigation surface. A trusted
   `pulls.get` read at job start is still allowed for PR identity, head/base SHAs, fork
   state, title/body, and repository URLs. Publish/idempotency reads and a final head
   check remain server-owned.
6. Local `git diff <baseSha>...<headSha>` becomes the primary source for changed paths
   and commentable RIGHT-side ranges. GitHub remains final authority at publish time; if
   an inline anchor is rejected, the server downgrades to summary-only and records
   telemetry instead of asking the agent to guess another line.
7. Slash-command reviews get one stale-head reschedule. If a slash review reaches publish
   after the PR head has changed, the worker may schedule one replacement run preserving
   the original command context. If the replacement also goes stale, it fails with retry
   guidance instead of rescheduling indefinitely.

## Consequences

- Worker runtime now depends on `git`, disk-space admission checks, stale workspace
  cleanup, and per-run workspace cleanup.
- GitHub API rate-limit pressure moves out of investigation and remains only around
  trusted metadata and publish/idempotency operations.
- Local diff parity becomes a publish-critical invariant and must be covered by tests
  using real temporary git repositories.
- Cursor no longer runs against the pr-agent source `cwd`; it runs against the
  agent-visible tree while preserving `local.settingSources: []`.
- Pi coding-agent must use in-memory or temp per-run storage in production workers;
  workers must not write default `~/.pi` state.

## Alternatives considered

- Keep GitHub read tools and only add local file access. Rejected because the target
  architecture removes GitHub reads from the agent investigation surface.
- Remove all GitHub reads. Rejected because PR metadata, final head checks, and publish
  idempotency still require trusted GitHub state.
- Allow agents to see `.git` and run shell commands. Rejected because review jobs are
  read-only and PR code is untrusted.
