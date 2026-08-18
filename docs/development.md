# Development guide

Module layout, import rules, and the runtime topology diagram rubric for **pr-agent**. Agent index: [AGENTS.md](../AGENTS.md). Cursor Cloud VM setup: [cursor-cloud.md](cursor-cloud.md).

Binding review rules live in [`.pr-agent/*.mdc`](../.pr-agent/) — this guide indexes areas and links those rules; do not restate `.mdc` bodies here.

## Module layout (production)

| Area                      | Path                                           | Public entry                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review run + publish      | `src/review/`                                  | `orchestrator/orchestratorRun.ts`, `publish/publishReview.ts`, `ci/analyzeCi.ts` (LLM CI summary: `ci/authorCiSummary.ts`); metrics/footer helpers under `run/`                                                                              |
| Local PR workspace        | `src/prWorkspace/`                             | `index.ts` (`withPrRepositoryView`); `workspaceResource.ts` owns temp-root allocation, ownership marker/heartbeat, credentials, and idempotent release                                                                                       |
| Code index (optional FTS) | `src/codeIndex/`                               | `buildJob.ts`, `search.ts`, `repository.ts`                                                                                                                                                                                                  |
| Agent work intake         | `src/agentWork/intake/`                        | `planner.ts` (pure), `applier.ts` (Postgres + pg-boss)                                                                                                                                                                                       |
| Agent work execution      | `src/agentWork/executors/`                     | `index.ts`                                                                                                                                                                                                                                   |
| Web / worker layers       | `src/agentWork/runtime.ts`, `workerRuntime.ts` | `agentWorkWebLive` (web); `agentWorkWorkerLive` (worker-only import graph)                                                                                                                                                                   |
| Ask / description         | `src/agent/`                                   | `ask/askRun.ts`, `description/descriptionRun.ts`                                                                                                                                                                                             |
| Pi session seam           | `src/agent/runtime/`                           | `piSession.ts` (`createPiSession`, `createFakePiSession`); `createFeaturePiSession` wraps `send` and `restartWithFallback` so fallback sessions keep checkpoint/snapshot persistence — feature harnesses must not import raw Pi SDK sessions |
| PR surface seam           | `src/github/`                                  | `prSurface.ts` (`createPrSurface`, `createFakePrSurface`) — worker/feature code must not import `prSurfaceImpl.ts` or thread installation tokens                                                                                             |
| Agent tool outputs        | `src/agent/tools/`                             | `toolOutputBudget.ts`, `localWorkspaceTools.ts`, `codeIndexTools.ts`, `context7Tools.ts`                                                                                                                                                     |
| Analytics facade          | `src/analytics/`                               | `index.ts` (`initAnalytics`, `captureEvent`, `captureException`, `shutdownAnalytics`)                                                                                                                                                        |

Public entries and placement-import rules: [`.pr-agent/module-layout.mdc`](../.pr-agent/module-layout.mdc). ESM `.js` imports and settings barrel: [`.pr-agent/esm-imports.mdc`](../.pr-agent/esm-imports.mdc).

## Landing site

The marketing site (`site/`, package `pr-agent-landing`) is a separate workspace package. It is not required to run the bot.

Agent-facing copy lives in [`site/lib/llmsKnowledge.ts`](../site/lib/llmsKnowledge.ts). The human page stays a short overview. Agents read `/llms.txt`, `GET /llms?query=`, and `GET /llms/json?query=`.

## Internal errors (`AppError`)

Production failures in `src/` use `AppError` from `src/errors/appError.ts`. Field rules, helpers, domain subclasses, and the AppError-never-on-PR rule: [`.pr-agent/structured-errors.mdc`](../.pr-agent/structured-errors.mdc).

## Prompt prose

Long investigator prompt blocks stay in prompt modules under `src/review/prompts/` and `src/agent/`. Only numeric limits and shared user-visible strings belong in `src/settings/*Constants.ts`. Binding rule: [`.pr-agent/prompt-vs-constants.mdc`](../.pr-agent/prompt-vs-constants.mdc).

## README runtime topology diagram

When a change alters **runtime topology**, update the Mermaid diagram in [README.md](../README.md) **How It Works** in the same PR. Binding rule: [`.pr-agent/topology-diagram.mdc`](../.pr-agent/topology-diagram.mdc).
