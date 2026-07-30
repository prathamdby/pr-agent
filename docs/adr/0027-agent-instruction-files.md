# ADR 0027 — Root agent instruction files in review trusted context

## Status

Accepted.

## Context

Many repositories already document agent behavior in root files such as `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`. Review runs only injected maintainer **repo policy rules** under `.pr-agent/*.mdc`. Investigators could discover root instruction files via workspace tools, but nothing guaranteed they were loaded, and the evidence bar forbade citing documents that might not exist.

## Decision

1. **Statically load** `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` from the PR head checkout root on every orchestrated review run.
2. **Inject** accepted bodies into a sibling trusted-context block, parallel to repo policy, with separate aggregate/per-file byte budgets large enough for real instruction docs (not the short `.mdc` instruction-char squash).
3. **Preserve newlines** in the rendered block; do not expand `@include` pointers.
4. **Trust boundary (fork vs same-repo):**
   - **Same-repo head:** treat present files as **binding** for that review (Trusted context label): evidenced violations matching the lens reporting gate are ordinary findings; prompts may cite these filenames when they appear in trusted context. Always append an **anti-suppression** line so local authors cannot trivially jailbreak severity.
   - **Fork / untrusted head:** render under an **Untrusted context** header — never “Trusted context” / never “binding”. Same anti-suppression line applies. Author-writable PR-head files must not inject privileged binding instructions.
5. **Do not load** these files for ask, describe, triage, or verification in this change.

## Consequences

- Reviews of agent-scaffolded repos can enforce the repo’s own agent contracts without requiring a `.pr-agent/` migration.
- Fork PRs cannot elevate attacker-writable instruction files to Trusted/binding labels.
- Pointer-only `CLAUDE.md` bodies remain thin unless the agent opens the target via tools.
- The orchestrator and all specialists receive the shared guidance block, which increases their prompt cost.

## Reversal

Remove `loadAgentInstructionFiles` / trusted-context wiring and the prompt guidance; leave `.pr-agent/*.mdc` policy unchanged.
