# ADR 0047: Adaptive-thinking prompts and request profile

## Status

Implemented for prompts, tool contracts, and the Anthropic Messages request
profile. The measurement, shared-prefix, and structured no-tool work listed under
Deferred is not implemented.

## Context

Adaptive-thinking Claude models (Opus 4.7 and later, including Opus 5.x) follow
instructions literally and need no pressure to investigate. Prompts written for
older models told them to keep findings rare, used confidence ladders and numeric
caps that the server does not enforce, repeated the causal-publication contract,
and wrapped each turn in step-by-step choreography. Several tool descriptions did
not match their executors.

The request side had separate gaps. A `models.json` entry could not declare the
Anthropic compat flags, so a gateway-served adaptive model received budget
thinking and a temperature. The orchestrator changed effort between phases inside
one session, which rewrites the Anthropic prompt cache. A safety-classifier
refusal was retried like a provider error. Compaction kept thinking blocks bound
to the prefix it had just rewritten.

## Decision

Everything stays provider-agnostic. Anthropic-only behavior is gated on
`api === "anthropic-messages"` or a catalog compat flag; other providers see the
same request shape as before.

Request profile:

- `models.json` accepts the Anthropic compat flags (`forceAdaptiveThinking`,
  `supportsTemperature`, `supportsStrictTools`, `supportsMidConvoEffort`,
  `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges`) at provider or
  model level, and a per-model `thinkingLevelMap`. Model compat merges over
  provider compat.
- Ask and triage turns default to `medium` effort; other phase defaults are
  unchanged. `PI_THINKING_CEILING` still caps every phase.
- On `anthropic-messages`, the review orchestrator session resolves one level for
  all of its phases (the highest of them, after the ceiling). Specialists and
  other roles keep per-phase levels; each runs in its own session.
- `rawStopReason === "refusal"` stops the retry loop and raises
  `provider.refusal`. No empty-text nudge follows it, and the specialist and
  orchestrator send retries stop on it too. A refused orchestrator session is
  retired, so the run publishes its deterministic fallback with no repair or
  recovery sends.
- PR Agent does not pass `maxTokens`; Pi clamps the model default.

History:

- When the model has `forceAdaptiveThinking`, compaction strips thinking blocks
  from the retained tail. The cut still lands on a safe boundary, so tool calls
  and results stay paired.
- The summarizer prompt treats the conversation as untrusted data, keeps
  findings, evidence ranges, and owed tool calls, and asks for `low` reasoning
  when the model supports it, because thinking shares the summary's token limit.
- Generation trace spans record `raw_stop_reason` and the provider-native
  `effort`.

Tool contracts:

- Every model-facing tool schema goes through `toToolParameters`, which closes
  objects with `additionalProperties: false`. Validation stays in valibot.
- Shared parameter definitions carry descriptions. Tool descriptions state what
  the executor actually does, including server-side normalization the model
  cannot see.
- A terminal submit tool that returns `accepted: false` or `ok: false` with an
  `error` surfaces as a `tool.submit_rejected` tool error. The turn budget no
  longer counts it as a finished submit, so the model can correct it in-turn.
- The first specialist report whose findings lack read evidence is recorded with
  the evidenced findings and answered with the dropped list, so the model can
  read the lines and resubmit once.
- `fixPrompt` is required and non-blank on every finding.

Prompts:

- Positive goals and done-criteria replace step lists, pressure, the confidence
  ladder, unenforced caps, and duplicated contracts. The judgment turn refers to
  the system prompt's causal-publication contract instead of repeating it.
- The security keep-list is unchanged: untrusted-evidence wrapping and
  neutralization, `FINDING_ANTI_SUPPRESSION`, the user-supplement rule, the
  specialist untrusted-evidence guidance, repository policy anti-suppression,
  and the Context7 outbound rules.
- Limits the schema enforces stay in the prompt with their reason.

## Deferred

- Measurement: a seeded-bug eval corpus and wire capture of request payloads.
  The corpus needs new fixtures, which stay opt-in.
- A shared review kernel and one specialist prefix shared across personas. The
  four personas still have separate system prompts, so ADR 0025's per-role
  prefixes are unchanged.
- Strict tools for the CI author and bound-policy judge in place of JSON parsed
  from prose.

## Failure modes recorded before implementation

1. A compat flag reaches a non-Anthropic provider and changes its request.
2. Holding effort raises a phase above `PI_THINKING_CEILING`.
3. Compaction separates a tool call from its result.
4. A refusal is retried or nudged until the send budget runs out.
5. A rejected submit ends the turn as if it had succeeded.
6. A specialist that stops after evidence feedback loses its evidenced findings.
7. Closing tool schemas changes what valibot accepts.
8. A prompt rewrite removes a security keep-list rule.

## Verification

`nub run dump-prompt all` before and after shows the prompt and tool-definition
changes and no keep-list removals. The existing unit suite passes with its pinned
prompt contracts updated to the new wording. No new tests were added. Refusal
handling, the effort hold, and compaction thinking stripping still need a live
run on an adaptive-thinking model.
