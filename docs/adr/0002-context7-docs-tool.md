# ADR 0002 — Context7 docs tool, direct REST instead of `@upstash/context7-sdk`

## Status

Accepted.

## Context

We added a Context7 documentation-lookup tool to the agent's tool set (`src/agent/tools/context7Tools.ts`) so the review loop can verify upstream API behaviour before flagging findings. The natural client would be `@upstash/context7-sdk`, but its constructor (`packages/sdk/src/client.ts:22-28` as of v0.3.0) hard-throws when neither the `apiKey` constructor option nor the `CONTEXT7_API_KEY` env var is set. We want anonymous fallback (rate-limited but functional) so the tool keeps working in local smoke tests and forks that have not signed up for an API key — which the SDK forbids. The same tools are also exposed to ask runs, so model-controlled request data needs one shared outbound boundary.

## Decision

`src/agent/tools/context7Tools.ts` calls `https://context7.com/api/v2/libs/search` and `/v2/context` directly via Node's native `fetch`; the endpoint paths are internal constants and callers cannot provide a host. `src/security/context7OutboundPolicy.ts` is shared by review and ask through `buildContext7Tools`: it accepts canonical library identifiers, bounds short query/topic text, rejects control characters, URLs, prompt blocks, conversation/comment markers, source excerpts, repository-sized content, and secret-shaped input, and redacts secret-shaped provider responses. The `Authorization: Bearer ...` header is attached only when `cfg.context7ApiKey` is non-empty; the key is never placed in a URL, error detail, log field, or tool result. Two tools are exposed to the LLM, named `resolveLibraryId` and `getLibraryDocs`. Response byte caps and anonymous fallback remain unchanged.

## Consequences

- We lose the SDK's 5-retry exponential backoff (`packages/sdk/src/client.ts:39-42`). A transient Context7 failure surfaces to the LLM as an `isError: true` `toolResult` on the first try, and the model can retry on a later turn.
- Context7 remains a documentation-verification tool, not a general outbound channel. Agents must not send raw source, prompts, comments, credentials, or tool output; rejected requests fail before URL construction and contain no rejected value in their errors.
- The Context7 REST contract is now a private dependency of this repo. If `/v2/libs/search` or `/v2/context` change shape, the tool breaks before the SDK would.

## Reversal

If Context7 exposes an explicit "anonymous mode" SDK constructor (e.g. `new Context7({ allowAnonymous: true })`), swap the `fetch` calls in `context7Tools.ts` for the SDK. The tool surface (`resolveLibraryId` / `getLibraryDocs`) and the system-prompt directive in `src/review/prompts/reviewSystemPrompt.ts` stay unchanged.
