# ADR 0052: PR voice contract

## Status

Accepted. Amends the Prompts section of
[ADR 0047](0047-adaptive-thinking-prompt-and-request-profile.md) for prose a
person reads on the pull request. Investigation guidance keeps the ADR 0047
goal style.

## Context

ADR 0047 replaced pressure, step lists, and unenforced numeric caps with goals
and done-criteria. Every provider receives the same prompts, and models that
treat goal-style guidance as optional still write padded, hedged review
comments and ask replies.

`readerFirstOutputGuidance` in `src/agent/prompts/readerFirstOutput.ts` states
the reader-first goal for the specialists, the orchestrator, triage, and ask.
It names no concrete patterns to avoid. Verification, description, and the CI
author did not include it. The orchestrator could reword specialist findings,
while the judgment turn's accepted-finding references and same-file dedup
compare normalized titles and details.

## Decision

1. `readerFirstOutputGuidance` lists patterns to never write: openers and
   closers, empty hedges, hype words, labeled fragments in place of sentences,
   and emojis, exclamation marks, or headers on a short answer. One weak and
   one strong example follow.
2. The list carries no backticks, because review gate fields reject markdown,
   pipes, and backticks.
3. Hedges are banned only when empty. A named unconfirmed step stays allowed,
   and the P2 and confidence contracts still require it.
4. Verification, description, and the CI author include the block.
   Verification asks for one-sentence evidence or reason with the file and line.
5. The orchestrator publishes accepted findings with the specialist's title and
   detail as written, and rewords only to split a compound finding.
6. Mergeability and blast radius are one sentence of 25 words or fewer. Ask
   defaults to 1 to 4 sentences or up to 5 bullets, under about 120 words, and
   exempts numbered steps, code, and explain or walkthrough requests.
7. These length targets are prompt guidance, not enforced limits. Schemas,
   constants, tool definitions, validators, and renderers do not change. This
   is the exception to ADR 0047's "no unenforced caps" rule, and it covers
   output prose only.

### Failure modes

1. The orchestrator rewords findings, so accepted-finding references and dedup
   stop matching and duplicate threads appear.
2. Banned patterns leak into excluded fields as backticks in gate fields.
3. The hedge ban removes the unconfirmed step a P2 finding needs.
4. Ask cuts steps a multi-step answer needs.

## Verification

`nub run dump-prompt all` before and after shows identical tool definitions and
additions only in system and turn prompt text. The existing unit suite passes
without changes. Output quality needs a live run on a test App: the same pull
request head reviewed before and after, with accepted-finding counts, summary
validation, and ask length compared.

## Consequences

- Each user-facing role's system prompt grows by about ten lines, and the
  prompt cache resets once at deploy (ADR 0025).
- A future prompt cleanup that cites ADR 0047 to remove these targets must
  revisit this ADR first.
- Some models may still ignore prompt-only rules. A server-side length check
  would be a separate decision.
