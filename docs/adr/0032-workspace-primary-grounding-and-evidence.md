# ADR 0032: Workspace-primary grounding and evidence

## Status

Accepted.

## Context

Orchestrated reviews investigate code through a **Local PR workspace** at the PR
head SHA, with GitHub `listFiles` as the anchor authority ([ADR 0017](0017-full-context-local-pr-workspace.md)).
Maintainers need reviews that are trustworthy and navigable: findings should be
backed by verified workspace reads, partial checkout coverage must not look
complete, and lifecycle decisions need a durable audit trail that never stores
prompts or repository content ([ADR 0031](0031-pi-native-agent-runtime.md)).

Cross-PR preference memory remains committed `.pr-agent/*.mdc` rules only
([ADR 0025](0025-mdc-repo-policy.md)). Optional navigation aids (ephemeral symbol
index, Postgres FTS code index) must never become publish authority. Cost kill
switches and golden-PR eval suites are out of scope for this program.

## Decision

1. **Workspace @ `headSha` is the sole publishable code authority.** GitHub
   `listFiles` remains the anchor authority for inline placement. Indexes and
   search hints may navigate; they may not justify a finding without a following
   workspace read of the cited lines at the reviewed head.
2. **Agent events are metadata-only.** Append-only `agent_events` rows record
   lifecycle, decision, publish, coverage, and evidence-reject milestones.
   Reaffirm [ADR 0031](0031-pi-native-agent-runtime.md): no prompts, model text,
   reasoning, repository content, tool payloads, credentials, or installation
   tokens in event `detail`.
3. **Evidence is required for publishable findings.** A finding that cites a
   file and line range must be covered by a successful workspace read (or
   equivalent verified tool) at the work item’s `headSha` before it may appear
   in an inline batch or summary table. Documented exceptions: summary-only
   findings after placement/anchor failure may still publish when explicitly
   marked summary-only by the existing placement path (prefer evidence when the
   path is known); empty/trivial reviews with no findings are N/A; ask and
   description paths are out of scope.
4. **Cross-PR finding history is threshold memory, not preference memory.**
   Fingerprint outcomes (`open` / `fixed` / `already-resolved` / `dismissed` /
   `skipped`) may suppress or deprioritize repeats after an evidence threshold.
   Never store maintainer free-text or auto-write `.mdc`. Durable prefs stay in
   committed `.pr-agent/*.mdc` ([ADR 0025](0025-mdc-repo-policy.md)).
5. **Code index is optional, default off, workspace-only degrade.** FTS hints
   (and any later embedding column) are navigation only. Missing or stale
   snapshots return unavailable; the review continues on the local workspace.
6. **No cost guard and no golden-PR eval suite in this program.** Operator-facing
   spend kill switches and golden-PR evaluation harnesses are explicitly out of
   scope here.

## Consequences

- New Postgres tables: `agent_events`, `repo_finding_history`, optional
  `code_index_*` (FTS first; no required `pgvector`).
- Tool and trusted-context surfaces expose **checkout coverage** so sparse or
  truncated search cannot be mistaken for full-repo certainty.
- Publish and specialist submit paths gain an evidence gate; default Compose
  remains behavior-compatible when optional writers/indexes fail or are disabled.
- Retention must cover event and code-index rows without expanding the ADR 0031
  audit boundary.

## Alternatives considered

- **RAG-primary grounding** — Rejected; indexes must not become publish authority.
- **Silent preference learning from dismissals** — Rejected; ADR 0025 owns prefs.
- **Required pgvector / Tiger Cloud** — Rejected for v1 portability; plain Postgres
  FTS first.
- **BudgetGuard / golden-PR eval in this pack** — Rejected by operator scope.
