# Development guide

Module layout, import rules, and the runtime topology diagram rubric for **pr-agent**. Agent index: [AGENTS.md](../AGENTS.md). Cursor Cloud VM setup: [cursor-cloud.md](cursor-cloud.md).

Binding review rules live in [`.pr-agent/*.mdc`](../.pr-agent/) — this guide indexes areas and links those rules; do not restate `.mdc` bodies here.

## Module layout (production)

| Area                      | Path                                           | Public entry                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review run + publish      | `src/review/`                                  | `orchestrator/orchestratorRun.ts`, `publish/publishSummaryOnly.ts`, `publish/publishFindingBatch.ts`, `ci/analyzeCi.ts` (LLM CI summary: `ci/authorCiSummary.ts`); metrics/footer helpers under `run/`                                       |
| Local PR workspace        | `src/prWorkspace/`                             | `index.ts` (`withPrRepositoryView`); `workspaceResource.ts` owns temp-root allocation, ownership marker/heartbeat, credentials, and idempotent release                                                                                       |
| Code index (optional FTS) | `src/codeIndex/`                               | `buildJob.ts`, `search.ts`, `repository.ts`                                                                                                                                                                                                  |
| Agent work intake         | `src/agentWork/intake/`                        | `planner.ts` (pure), `applier.ts` (Postgres + pg-boss)                                                                                                                                                                                       |
| Agent work execution      | `src/agentWork/executors/`                     | `index.ts`                                                                                                                                                                                                                                   |
| Web / worker layers       | `src/agentWork/runtime.ts`, `workerRuntime.ts` | `agentWorkWebLive` (web); `agentWorkWorkerLive` (worker-only import graph)                                                                                                                                                                   |
| Ask / description         | `src/agent/`                                   | `ask/askRun.ts`, `description/descriptionRun.ts`                                                                                                                                                                                             |
| Pi session seam           | `src/agent/runtime/`                           | `piSession.ts` (`createPiSession`, `createFakePiSession`); `createFeaturePiSession` wraps `send` and `restartWithFallback` so fallback sessions keep checkpoint/snapshot persistence — feature harnesses must not import raw Pi SDK sessions |
| PR surface seam           | `src/github/`                                  | `prSurface.ts` (`createPrSurface`, `createFakePrSurface`); leased mutation recovery is `recoverPrSurfaceMutation.ts` — worker/feature code must not import `prSurfaceImpl.ts` or thread installation tokens                                  |
| Agent tool outputs        | `src/agent/tools/`                             | `toolOutputBudget.ts`, `localWorkspaceTools.ts`, `codeIndexTools.ts`, `context7Tools.ts`; review sessions fence results with `wrapUntrustedEvidence` in `src/review/run/reviewRunSetup.ts`                                                   |
| Outbound security         | `src/security/`                                | `redactOutboundSecrets.ts`, `context7OutboundPolicy.ts`                                                                                                                                                                                      |
| Analytics facade          | `src/analytics/`                               | `index.ts` (`initAnalytics`, `captureEvent`, `captureException`, `shutdownAnalytics`)                                                                                                                                                        |

Public entries and placement-import rules: [`.pr-agent/module-layout.mdc`](../.pr-agent/module-layout.mdc). ESM `.js` imports and settings barrel: [`.pr-agent/esm-imports.mdc`](../.pr-agent/esm-imports.mdc).

## Landing site

The marketing site (`site/`, package `pr-agent-landing`) is a separate workspace package. It is not required to run the bot. When `VITE_POSTHOG_PROJECT_TOKEN` is set at build time, the root layout loads posthog-js and captures `$pageview` on navigation.

Agent-facing copy lives in [`site/lib/llmsKnowledge.ts`](../site/lib/llmsKnowledge.ts). The human page stays a short overview. Agents read `/llms.txt`, `GET /llms?query=`, and `GET /llms/json?query=`.

Every agent-facing URL is declared once in [`site/lib/agentResources.ts`](../site/lib/agentResources.ts), which renders llms.txt link lists, `robots.txt` pointers, `sitemap.xml`, `/openapi.json`, the 404 body and page, the `Link` headers, and the head's `alternate`/`describedby` links. Add an endpoint there, not in each surface; surfaces that point at one resource by identity use its named registry entry.

`/` negotiates on `Accept`: HTML by default, `text/markdown` when asked, and 406 when neither is acceptable. The parser is [`site/lib/accept.ts`](../site/lib/accept.ts); responses and the 404 recovery document are [`site/lib/siteHttp.ts`](../site/lib/siteHttp.ts); the request middleware that applies them is [`site/start.ts`](../site/start.ts). Markdown for `/` is rendered from the same constants as the React page in [`site/lib/pageMarkdown.ts`](../site/lib/pageMarkdown.ts), so the two representations cannot drift. `/` is not prerendered: the server function must see every request for negotiation to work.

## Internal errors (`AppError`)

Production failures in `src/` use `AppError` from `src/errors/appError.ts`. Field rules, helpers, domain subclasses, and the AppError-never-on-PR rule: [`.pr-agent/structured-errors.mdc`](../.pr-agent/structured-errors.mdc). `serializeAppError` and `errorLogFields` are the canonical sanitized representation for telemetry; evlog, analytics, PostHog, and startup logging sanitize Error values and metadata again at their boundaries, so callers do not need to pre-sanitize contexts or causes.

## Prompt prose

Long investigator prompt blocks stay in prompt modules under `src/review/prompts/` and `src/agent/`. Only numeric limits and shared user-visible strings belong in `src/settings/*Constants.ts`. Binding rule: [`.pr-agent/prompt-vs-constants.mdc`](../.pr-agent/prompt-vs-constants.mdc). The correctness persona prompt includes an ordered risk-directed investigation method; the catalogue remains supporting recognition.

## README runtime topology diagram

When a change alters **runtime topology**, update the Mermaid diagram in [README.md](../README.md) **How It Works** in the same PR. Binding rule: [`.pr-agent/topology-diagram.mdc`](../.pr-agent/topology-diagram.mdc).
