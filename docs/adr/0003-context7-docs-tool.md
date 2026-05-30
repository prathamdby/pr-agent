# ADR 0003 — Context7 docs tool, direct REST instead of `@upstash/context7-sdk`

## Status

Accepted.

## Context

We added a Context7 documentation-lookup tool to the agent's tool set (`src/agent/context7Tools.ts`) so the review loop can verify upstream API behaviour before flagging findings. The natural client would be `@upstash/context7-sdk`, but its constructor (`packages/sdk/src/client.ts:22-28` as of v0.3.0) hard-throws when neither the `apiKey` constructor option nor the `CONTEXT7_API_KEY` env var is set. We want anonymous fallback (rate-limited but functional) so the tool keeps working in local smoke tests and forks that have not signed up for an API key — which the SDK forbids.

## Decision

`src/agent/context7Tools.ts` calls `https://context7.com/api/v2/libs/search` and `/v2/context` directly via Node's native `fetch`. The `Authorization: Bearer ...` header is attached only when `cfg.context7ApiKey` is non-empty. Two tools are exposed to the LLM, named `resolveLibraryId` and `getLibraryDocs` to match the camelCase convention of the surrounding `@github-tools/sdk` tool set.

## Consequences

- We lose the SDK's 5-retry exponential backoff (`packages/sdk/src/client.ts:39-42`). A transient Context7 failure surfaces to the LLM as an `isError: true` `toolResult` on the first try, and the model can retry on a later turn. This matches how `@github-tools/sdk` failures are already handled.
- The Context7 REST contract is now a private dependency of this repo. If `/v2/libs/search` or `/v2/context` change shape, the tool breaks before the SDK would.

## Reversal

If Context7 exposes an explicit "anonymous mode" SDK constructor (e.g. `new Context7({ allowAnonymous: true })`), swap the `fetch` calls in `context7Tools.ts` for the SDK. The tool surface (`resolveLibraryId` / `getLibraryDocs`) and the system-prompt directive in `src/review/reviewRun.ts` stay unchanged.
