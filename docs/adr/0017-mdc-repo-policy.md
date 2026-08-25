# ADR 0017 — Repo policy as `.pr-agent/*.mdc` rules

## Status

Accepted.

## Context

Repo preference memory lived in a single structured `.pr-agent.yml` file (`tone`, `severityFloor`, `pathInstructions`, `lensOverrides`). Maintainers think in Cursor-style rule files, and policy suggestions that emitted YAML fragments were awkward to commit beside prose guidance.

ADR 0016 grounded verification dismiss suggestions against that YAML file (append vs starter).

## Decision

1. **Replace YAML with a flat `.pr-agent/` directory of `.mdc` files.** Each file is one rule: optional YAML frontmatter (`globs`, `alwaysApply` only) plus a markdown body of instructions.
2. **Load all usable `.mdc` rules at review preflight** from the PR head checkout. Keep parsing, file/byte caps, and changed-file matching independent from trust. Include a rule when it is effectively always-apply (explicit `alwaysApply: true`, or neither `alwaysApply` nor `globs` set) or when any changed file matches its globs.
   - When the PR head and base `repo.full_name` values match, render matching rules as binding **Trusted context (repo policy)**. Add the anti-suppression contract to the block.
   - When either repository identity is missing or malformed, or the values differ for a fork, render matching PR-head rules only as fenced **Untrusted context (repo policy from PR head)**. Never let those bodies define binding review instructions; neutralize forged trusted/binding headers and delimiters.
   - This is the same fail-closed fork/base trust boundary used for root agent instruction files in [ADR 0019](0019-agent-instruction-files.md). Fork policy remains review evidence, not privileged control.
3. **Drop structured policy knobs** (`tone`, `severityFloor`, `lensOverrides`, `pathInstructions`). Instruction prose lives in rule bodies; there is no policy-derived publish severity floor.
4. **Do not read `.pr-agent.yml`.** No dual-read or automatic migration.
5. **Policy suggestions recommend `.mdc`:** when exactly one loaded rule matches the finding path, suggest an append fragment for that file; otherwise suggest a new `.pr-agent/<slug>.mdc` starter. Verification continues to ground suggestions from the checkout; triage (no checkout today) always suggests create-new.

## Consequences

- Maintainer memory matches Cursor `.mdc` authoring.
- Repos that relied on YAML `severityFloor` lose that mechanical publish gate.
- ADR 0016’s grounded-suggestion behavior remains, with `.mdc` append/new instead of YAML `pathInstructions`.
- Caps move to per-file / aggregate / file-count limits for the directory.
- Fork-controlled policy can still inform investigation as untrusted evidence, but it cannot suppress, omit, or downgrade findings.
- **Cross-PR finding history** ([ADR 0024](0024-workspace-primary-grounding-and-evidence.md)) stores fingerprint outcomes only; it is threshold suppression memory, not preference memory. Durable maintainer prefs remain committed `.pr-agent/*.mdc` here.

## Reversal

Restore `.pr-agent.yml` schema loading and YAML suggestion rendering; delete `.mdc` directory loading.
