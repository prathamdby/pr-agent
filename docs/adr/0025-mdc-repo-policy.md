# ADR 0025 — Repo policy as `.pr-agent/*.mdc` rules

## Status

Accepted.

## Context

Repo preference memory lived in a single structured `.pr-agent.yml` file (`tone`, `severityFloor`, `pathInstructions`, `lensOverrides`). Maintainers think in Cursor-style rule files, and policy suggestions that emitted YAML fragments were awkward to commit beside prose guidance.

ADR 0023 grounded verification dismiss suggestions against that YAML file (append vs starter).

## Decision

1. **Replace YAML with a flat `.pr-agent/` directory of `.mdc` files.** Each file is one rule: optional YAML frontmatter (`globs`, `alwaysApply` only) plus a markdown body of instructions.
2. **Load all usable `.mdc` rules at review preflight** from the PR head checkout. Include a rule when it is effectively always-apply (explicit `alwaysApply: true`, or neither `alwaysApply` nor `globs` set) or when any changed file matches its globs. Render matching rules into the trusted-context block.
3. **Drop structured policy knobs** (`tone`, `severityFloor`, `lensOverrides`, `pathInstructions`). Instruction prose lives in rule bodies; there is no policy-derived publish severity floor.
4. **Do not read `.pr-agent.yml`.** No dual-read or automatic migration.
5. **Policy suggestions recommend `.mdc`:** when exactly one loaded rule matches the finding path, suggest an append fragment for that file; otherwise suggest a new `.pr-agent/<slug>.mdc` starter. Verification continues to ground suggestions from the checkout; triage (no checkout today) always suggests create-new.

## Consequences

- Maintainer memory matches Cursor `.mdc` authoring.
- Repos that relied on YAML `severityFloor` lose that mechanical publish gate.
- ADR 0023’s grounded-suggestion behavior remains, with `.mdc` append/new instead of YAML `pathInstructions`.
- Caps move to per-file / aggregate / file-count limits for the directory.
- **Cross-PR finding history** ([ADR 0032](0032-workspace-primary-grounding-and-evidence.md)) stores fingerprint outcomes only; it is threshold suppression memory, not preference memory. Durable maintainer prefs remain committed `.pr-agent/*.mdc` here.

## Reversal

Restore `.pr-agent.yml` schema loading and YAML suggestion rendering; delete `.mdc` directory loading.
