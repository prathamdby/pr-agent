# ADR 0027 — Root agent instruction files in review trusted context

## Status

Accepted.

## Context

Many repositories already document agent behavior in root files such as `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`. Review runs only injected maintainer **repo policy rules** under `.pr-agent/*.mdc`. Investigators could discover root instruction files via workspace tools, but nothing guaranteed they were loaded, and the evidence bar forbade citing documents that might not exist.

## Decision

1. **Statically load** `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` from the PR head checkout root on every **Review run** (all lenses).
2. **Inject** accepted bodies into a sibling trusted-context block, parallel to repo policy, with separate aggregate/per-file byte budgets large enough for real instruction docs (not the short `.mdc` instruction-char squash).
3. **Preserve newlines** in the rendered block; do not expand `@include` pointers.
4. **Treat present files as binding** for that review: evidenced violations matching the lens reporting gate are ordinary findings; prompts may cite these filenames when they appear in trusted context.
5. **Do not load** these files for ask, describe, triage, or verification in this change.

## Consequences

- Reviews of agent-scaffolded repos can enforce the repo’s own agent contracts without requiring a `.pr-agent/` migration.
- Pointer-only `CLAUDE.md` bodies remain thin unless the agent opens the target via tools.
- Prompt cost budgets for every review lens grow by the shared guidance block.

## Reversal

Remove `loadAgentInstructionFiles` / trusted-context wiring and the prompt guidance; leave `.pr-agent/*.mdc` policy unchanged.
