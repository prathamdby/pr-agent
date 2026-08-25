# ADR 0026 — PR surface seam on the worker path

## Status

Accepted.

## Context

Webhook-path PR I/O once used an Effect `Context.Tag`. [ADR 0006](0006-durable-agent-work.md) moved reactions, progress comments, reviews, and ask replies onto durable workers. After that move, worker executors called Octokit helpers and threaded `token` / `expiresAtTs` through `githubPrSurface.ts`, `reviewPriorFeedback.ts`, and CI helpers — leaving no single worker-path seam.

An Effect `Layer` for worker-time PR I/O was rejected for the same reasons as the Pi runtime: [ADR 0006](0006-durable-agent-work.md) workers are Promise/pg-boss jobs, not Effect fibers, and [ADR 0023](0023-pi-native-agent-runtime.md) established a Promise factory + interface seam (`createPiSession` / `PiSession`) with a CI import-graph guard instead of Context tags.

## Decision

1. **`PrSurface`** (`src/github/prSurface.ts`) is the sole worker/feature entry for PR-surface GitHub I/O. Production code calls `createPrSurface`; tests use `createFakePrSurface`. Implementation stays in `prSurfaceImpl.ts` (not imported outside `src/github/`).

2. **No installation tokens outside `src/github/`**. Executors receive `PrSurface` on `DurableExecutionContext` (and mint only inside `durableJob.ts` when constructing a surface). `gitCredentialToken()` is the only credential escape hatch for `src/prWorkspace/` git checkout.

3. **CI guard** — `test/prSurfaceImportGraph.test.ts` fails when code outside `src/github/` imports `@octokit/*`, references `installationOctokit`, or exports signatures with `token: string` / `expiresAtTs` / `tokenExpiresAtTs` parameters.

4. **Binding rule** — `.pr-agent/pr-surface-seam.mdc` mirrors the Pi session seam rule (`.pr-agent/pi-session-seam.mdc`).

5. **Lease-aware mutation boundary** — leased durable executions inject a
   `PrSurfaceMutationBoundary` into the factory. Every mutating `PrSurface`
   method crosses that boundary; it persists an operation intent with the
   current lease epoch, checks the cancellation signal and epoch immediately
   before the external call, then reconciles the outcome. Read-only methods do
   not cross the boundary so a replacement worker can recover evidence after a
   stale execution is fenced. Unleased ask work keeps the ordinary surface.

## Consequences

- Token-threading helpers (`githubPrSurface.ts`, exported token params on CI/prior-feedback modules) are removed or internalized under `src/github/`.
- Failure-path hooks (`onCancelled`, `onTerminalFailure`) take `PrSurface` instead of `InstallationToken`.
- Outcome reactions use `prSurface.setAcknowledgementReaction` rather than free functions with tokens.
- Tests outside `src/github/` mock `PrSurface`; Octokit unit tests stay under `src/github/` and `test/` modules that target github internals directly.
- A stale leased worker cannot start a new PR mutation or advance its durable
  intent/publish state after renewal loss. An outcome that becomes ambiguous
  while the remote call is in flight remains recoverable through the durable
  intent and publish-record ledgers.

## Reversal

Revert `prSurface.ts` factory usage in executors and restore token-threaded helpers. Remove the import-graph test and binding rule. Expect duplicate Octokit call sites and executor signature churn to return.
