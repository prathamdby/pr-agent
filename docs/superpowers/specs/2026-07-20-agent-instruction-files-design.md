# Design: Load root agent instruction files into review trusted context

## Goal

Statically discover `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` at the PR head checkout root, inject their bodies into review trusted context (parallel to `.pr-agent/*.mdc` repo policy), and require investigators to flag evidenced violations.

## Decisions (locked)

1. **Weight:** Same as repo policy — binding trusted context; violations are reportable findings.
2. **Files:** Repo-root only, fixed order: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`.
3. **Includes:** Raw bodies only — no `@path` / markdown-link expansion.
4. **Surfaces:** Review runs only (all lenses).
5. **Composition:** Sibling trusted block + separate byte budgets from repo policy.
6. **Apply:** Always-on when any file loads successfully.
7. **Budgets (peer-review fix):** Do **not** reuse `MAX_REPO_POLICY_INSTRUCTION_CHARS` (1000). Caps: 32 KiB per file, 64 KiB aggregate. Preserve newlines in the rendered block.

## Data model

```ts
type AgentInstructionFile = {
  readonly filename: "AGENTS.md" | "CLAUDE.md" | "GEMINI.md";
  readonly body: string;
};

type AgentInstructionFilesResult =
  { kind: "absent" } | { kind: "ok"; files: readonly AgentInstructionFile[] };
```

## Load algorithm

1. For each filename in fixed order under `agentCwd`.
2. Missing → skip. Not a regular file → skip + warn.
3. Size > per-file byte cap → skip + warn.
4. Read UTF-8; trim; empty → skip.
5. If aggregate would exceed budget → stop accepting further files + warn.
6. Zero accepted → `absent`; else `ok`.

## Render

```
Trusted context (agent instruction files):
These root files are binding for this review. Flag evidenced violations as findings (lens reporting gate still applies).

### File `AGENTS.md`
<body with newlines preserved>

### File `CLAUDE.md`
…
```

Omit the block entirely when `absent`.

## Wire-in

- `reviewExecutor`: load beside `loadRepoPolicy`; pass `agentInstructionFilesBlock` into `buildTrustedReviewContextForReview`.
- Prompt: allow citing these filenames; add shared guidance block to every review lens.
- Docs: `CONTEXT.md` term, `docs/configuration.md` caps, ADR 0027.

## Out of scope

Ask / describe / triage / verification; nested paths; `.cursor/rules`; `@include` expansion; env overrides for the filename list.
