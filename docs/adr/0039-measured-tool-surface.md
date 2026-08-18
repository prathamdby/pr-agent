# ADR 0039 — Measured tool surface, per-call tracing, and generated prompt contracts

## Status

Accepted.

## Context

Thirty days of orchestrator `agent_events` (304 review runs) showed a large recon loop of `getWorkspaceDiff`, `readWorkspaceFile`, and `searchWorkspace`, plus a tail of registered tools the agent almost never called. The same window showed invented tool names that do not exist. Tool-call telemetry covered only the review orchestrator, so other lanes could not be measured.

ADR 0003 stays in force: Context7 remains the library-docs path even though `resolveLibraryId` and `getLibraryDocs` were below the bar in that window.

## Decision

1. **The bar.** A tool survives in a lane if it is called in at least 70% of that lane's runs over the trailing 30 days. Measurement is `agent_events` tool rows and the PostHog event `agent tool called`.

2. **The cut (one wave, all lanes, no shims, no new flags).** Remove `searchCodeIndex` (0.7% of orchestrator runs), `resolveSymbol` (10%), and `getWorkspaceBlame` (17%) from every lane. The code-index cascade follows: agent tool, prompt status line, build and retention jobs, worker/boss wiring, and `CODE_INDEX_*` env knobs. Postgres `code_index_*` tables and migration history stay.

3. **Dead publish tool.** Delete `submitReview`. It had no runtime caller; only tests referenced it. Public-output sanitizer tests may still mention the word.

4. **Context7 stays.** Review (orchestrator and specialists) and ask keep `resolveLibraryId` and `getLibraryDocs`. Prompts route library-behavior and upstream-API questions to that pair.

5. **Tracing.** Every executor invocation in the Pi session seam captures `agent tool called` through the analytics facade and writes one durable tool row when events context is present. Properties are names and measurements only: tool name, session role, work type, phase, `ok`, duration, owner, repo, PR number. Capture is never awaited.

6. **Lane declaration.** Each lane declares its tool names once. Session assembly and the prompt tool-contract section both read that list. Unknown-tool and missing-executor errors repeat the same names.

## Measured cut list

| Tool                | Orchestrator run rate (30d) | Action                                                     |
| ------------------- | --------------------------- | ---------------------------------------------------------- |
| `searchCodeIndex`   | 0.7%                        | Removed from every lane; code-index jobs and knobs removed |
| `resolveSymbol`     | 10%                         | Removed from every lane                                    |
| `getWorkspaceBlame` | 17%                         | Removed from every lane                                    |
| `submitReview`      | no runtime caller           | Deleted                                                    |
| `resolveLibraryId`  | 16%                         | Kept on review and ask (ADR 0003)                          |
| `getLibraryDocs`    | 25%                         | Kept on review and ask (ADR 0003)                          |

## Consequences

- Future tool additions must clear the 70% bar in the target lane or record an explicit product exception (as Context7 does).
- Parallel specialists share `session_role` `specialist`, so they skip checkpoint durability and still receive events context for tool rows.
- A 30-day post-launch comparison of per-lane call rates is the rollback signal for this cut.

## Reversal

Restore the removed tools, code-index jobs/knobs, and `submitReview` from git history. Tables were never dropped.
