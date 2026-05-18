# ADR 0004 — Native pi-ai toolset; drop `@github-tools/sdk` and the AI-SDK bridge

## Status

Accepted.

## Context

The review agent's tool surface was 13 thin wrappers from `@github-tools/sdk` routed through `src/bridge/aiSdkToolsToPiTools.ts` to translate the AI-SDK tool shape into pi-ai's. The upstream SDK is shaped for the Vercel Workflow / durable-execution runtime — every tool body has a `"use step"` directive and an approval-gating system (which we already disabled with `requireApproval: false`). We carried that runtime baggage without using it, plus a `/workflow|use step|durable|approval required/i` regex in the bridge whose entire job was to apologize when callers hit the mismatch.

The actual surface was small and bounded: 12 single `octokit.rest.*` calls plus one GraphQL query for `getBlame`.

## Decision

`src/agent/githubTools.ts` owns the 13 tools directly. Each tool is authored as a Zod schema plus a thin `run()` that calls Octokit and maps the response. Schemas are converted to JSON Schema via `z.toJSONSchema(..., { unrepresentable: "any" })` for pi-ai's `parameters` field, and `schema.parse(args)` guards the executor at call time. `src/agent/context7Tools.ts` uses the same `{ piTools, executors }` shape so `runFullPrReview` merges two records and dispatches via `executors[call.name](call.arguments)`. The bridge module, the `@github-tools/sdk` dependency, and the `ai` dependency are deleted.

Response-shape normalizations were applied during the port (model-facing JSON):

- `author` is renamed to `authorLogin` in every tool where it represented a GitHub login.
- Commit tools (`listCommits`, `getCommit`) rename their git-author display name from `author` to `authorName`, alongside `authorLogin`.
- `searchCode.items[].repository` becomes `repositoryFullName`.
- `getCommit.totalChanges` becomes `changes` (parallels per-file `changes`).
- `listBranches` drops the `protected` field.
- `getBlame` throws `Error` instead of returning `{ error }` sentinels, so the agent loop's existing `isError: true` handling covers all 13 tools identically.

## Consequences

- We own ~13 thin Octokit wrappers and their response shapes; upstream tool additions no longer arrive for free.
- One way tools enter the agent loop: a `{ piTools, executors }` factory call. Adding a new tool is one entry in each map.
- The bridge's workflow-error-hint regex is gone; tool failures bubble unchanged.

## Reversal

Restoring `@github-tools/sdk` + the bridge means reinstating the two dependencies, restoring the bridge module and its test, and reverting `githubTools.ts` to the prior 11-line wrapper. The field-rename decisions above would need to be re-applied as a separate normalization step or accepted as a downgrade. Precedent for owning the surface directly is ADR-0003 (Context7); the same logic applies here.
