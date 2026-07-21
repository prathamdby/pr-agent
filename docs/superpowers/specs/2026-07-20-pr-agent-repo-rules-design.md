# Design: Dogfood `.pr-agent/*.mdc` repo policy for pr-agent

> **Historical design note:** Phrases like “general review lens” below describe the pre-[ADR 0028](../../adr/0028-orchestrated-review.md) multi-lens model. Current product behavior is one **orchestrated review run** with specialists; lens slash commands are retired (legacy recognition only).

## Goal

Commit a focused set of maintainer repo policy rules under `.pr-agent/` so reviews of this repository load the same durable preferences the product already supports (ADR 0025).

## Non-goals

- Replacing or restating investigator prompt methodology (evidence bar, reporting gate, security tripwires).
- Duplicating `AGENTS.md` / `CLAUDE.md` agent-instruction content already injected via ADR 0027.
- Restoring removed YAML knobs (`tone`, `severityFloor`, `lensOverrides`, `pathInstructions`).
- Nested rule directories or non-`.mdc` files.

## Constraints (from product)

- Flat `.pr-agent/*.mdc` only; frontmatter keys `globs` and `alwaysApply` only.
- Body ≤ 1000 chars (`MAX_REPO_POLICY_INSTRUCTION_CHARS`); ≤ 20 files; 8KB/file; 32KB aggregate.
- Rules must be phrased as **contract/invariant violations** so the general review lens can treat them as ordinary findings, not taste nits.

## Approaches considered

1. **Minimal dogfood (3–4 always-apply files)** — settings + web/worker + imports only. Lowest maintenance; misses path-specific ADR invariants (triage force-push, verification publish, site graph).
2. **Layered catalog (recommended)** — a few always-apply globals plus path-scoped rules for high-churn / high-risk areas. Fits caps; avoids AGENTS.md duplication.
3. **Exhaustive doc mirror** — one file per development/ops section. Burns policy budget, duplicates trusted agent-instruction files, and dilutes signal.

**Choice:** Approach 2.

## Rule set

| File                       | Apply                                                  | Purpose                                                          |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `settings-knobs.mdc`       | always                                                 | Magic numbers / defaults live in `src/settings/`; knob checklist |
| `feature-flags.mdc`        | globs: settings, config, features docs, `.env.example` | `FEATURE_*` only; no legacy `ENABLE_*` aliases                   |
| `esm-imports.mdc`          | always                                                 | NodeNext `.js` imports; no removed barrels                       |
| `exhaustive-unions.mdc`    | always                                                 | `never` default on union/enum switches                           |
| `module-layout.mdc`        | `src/**`                                               | Public entry points + reviewErrors import seam                   |
| `prompt-vs-constants.mdc`  | prompts + settings                                     | Long prose stays in prompt modules                               |
| `web-worker-boundary.mdc`  | agentWork / effect / webhook / commands                | No PR-surface I/O on web fibers (ADR 0009)                       |
| `topology-diagram.mdc`     | topology-sensitive paths                               | README Mermaid update when topology changes                      |
| `triage-safety.mdc`        | triage + writable checkout                             | Same-repo, no force-push, evidence for dismiss (ADR 0018)        |
| `verification-publish.mdc` | verification                                           | Read-only, stub ledger, quiet resolve (ADR 0020–0023)            |
| `site-isolation.mdc`       | `site/**` (+ prod dep check touchpoints)               | Landing package must not contaminate backend graph               |

## Deliberately omitted

| Topic                                             | Why                                                      |
| ------------------------------------------------- | -------------------------------------------------------- |
| Same-PR doc table / CONTEXT vocabulary            | Already in `AGENTS.md` agent-instruction trusted context |
| Cursor Cloud runbooks                             | Operator setup, not PR defect signal                     |
| Evidence bar / reporting gate / sanitizer details | Already in review prompts                                |
| Generic “prefer `nub`” / “never commit `.env`”    | CI / ops culture; low review finding value               |

## Success criteria

1. `loadRepoPolicy` on a checkout of this branch returns `kind: "ok"` with 11 usable rules.
2. Always-apply rules render for any changed-file set; path-scoped rules match their globs in `repoPolicy` unit tests’ mental model (manual smoke via reading frontmatter).
3. Each body is ≤ 1000 characters and uses CONTEXT.md vocabulary where product terms appear.
4. No code/constant/doc changes required beyond adding `.pr-agent/*.mdc` (and this design/plan under `docs/superpowers/`).

## Rollback

Delete `.pr-agent/`. Reviews proceed with `absent` policy as today.
