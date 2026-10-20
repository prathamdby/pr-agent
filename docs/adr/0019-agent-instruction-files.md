# ADR 0019 — Root agent instruction files in review trusted context

## Status

Accepted.

## Context

Many repositories already document agent behavior in root files such as `AGENTS.md` or `CLAUDE.md`. Review runs only injected maintainer **repo policy rules** under `.pr-agent/*.mdc`. Investigators could discover root instruction files via workspace tools, but nothing guaranteed they were loaded, and the evidence bar forbade citing documents that might not exist.

## Decision

1. **Load** `AGENTS.md` and `CLAUDE.md` from the recorded base commit on every orchestrated review run ([ADR 0059](0059-base-commit-policy-snapshot.md)).
2. **Inject** accepted bodies into a sibling trusted-context block, parallel to repo policy, with separate aggregate/per-file byte budgets large enough for real instruction docs (not the short `.mdc` instruction-char squash).
3. **Preserve newlines** in the rendered block; do not expand `@include` pointers.
4. **Trust boundary** ([ADR 0059](0059-base-commit-policy-snapshot.md)): present base files are binding trusted context. Head copies are untrusted proposed changes and are not binding. Prompts may cite `AGENTS.md` or `CLAUDE.md` only when that file appears in the instruction-files context. An absent file is not mentioned. Always append an **anti-suppression** line so local authors cannot trivially jailbreak severity.
5. **Do not load** these files for ask, describe, triage, or verification in this change.

## Consequences

- Reviews of agent-scaffolded repos can enforce the repo’s own agent contracts without requiring a `.pr-agent/` migration.
- Fork PRs cannot elevate attacker-writable instruction files to Trusted/binding labels.
- Pointer-only `CLAUDE.md` bodies remain thin unless the agent opens the target via tools.
- The orchestrator and all specialists receive the shared guidance block, which increases their prompt cost.

## Reversal

Remove `loadAgentInstructionFiles` / trusted-context wiring and the prompt guidance; leave `.pr-agent/*.mdc` policy unchanged.
