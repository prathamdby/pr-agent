# Design: `.pr-agent/*.mdc` repo policy (replace YAML)

## Goal

Replace the single `.pr-agent.yml` repo policy file with a flat directory of Cursor-style `.mdc` rule files under `.pr-agent/`. Completely remove YAML policy loading. Update policy suggestions (append + new) to recommend `.mdc` files.

## Decisions (locked)

1. **Approach:** Directory of rules → one aggregated trusted-context block.
2. **Frontmatter (minimal):** only `globs` (`string` | `string[]`) and `alwaysApply` (`boolean`). Markdown body holds all instruction prose. No `severityFloor`, `tone`, or `lens` structured fields.
3. **Default apply:** if neither `alwaysApply: true` nor any `globs` is set → always apply.
4. **Suggestions:** if exactly one existing rule matches the finding path (via effective always-apply or glob match) → suggest append to that file; otherwise suggest a new `.mdc`.
5. **Legacy:** do not read `.pr-agent.yml` (no dual-read, no migration).
6. **Layout:** flat `.pr-agent/*.mdc` only (no recursion).
7. **Triage:** triage has no repository checkout today → suggestions default to create-new `.mdc` (ungrounded). Verification continues to ground append/new from the checkout.

## Data model

```ts
type RepoPolicyRule = {
  readonly filename: string; // e.g. "security.mdc"
  readonly relativePath: string; // e.g. ".pr-agent/security.mdc"
  readonly alwaysApply: boolean; // effective (true when frontmatter omits both keys)
  readonly globs: readonly string[];
  readonly body: string;
};

type RepoPolicy = {
  readonly rules: readonly RepoPolicyRule[];
};

type RepoPolicyResult =
  { kind: "absent" } | { kind: "invalid"; reason: string } | { kind: "ok"; policy: RepoPolicy };
```

## Load algorithm

1. `stat(.pr-agent)` — ENOENT → `absent`; not a directory → `invalid`.
2. `readdir` for `*.mdc` regular files, sorted by filename for stable prompt order.
3. Zero candidates → `absent`.
4. For each file (up to `MAX_REPO_POLICY_FILES`):
   - Skip if size > `MAX_REPO_POLICY_FILE_BYTES` (warn).
   - Parse optional `---` YAML frontmatter; unknown keys ignored; malformed frontmatter → skip file (warn).
   - Validate `globs` / `alwaysApply` types; bad types → skip file (warn).
   - Trim body; empty body → skip.
   - Cap body to `MAX_REPO_POLICY_INSTRUCTION_CHARS`; cap each glob to `MAX_REPO_POLICY_PATH_PATTERN_CHARS`.
   - Enforce aggregate byte budget `MAX_REPO_POLICY_BYTES` across accepted file contents; stop accepting further files when exceeded (warn).
5. If no rules accepted after candidates existed → `invalid` ("no usable .mdc rules").
6. Else → `ok` with accepted rules.

## Apply / render

Include a rule when:

- `alwaysApply` is effectively true, or
- `changedFiles` omitted (render all applicable rules for suggestion context), or
- any changed file matches any glob (existing `matchesPathGlob` semantics).

Render:

```
Trusted context (repo policy):
- Rule `.pr-agent/<file>`: <body collapsed to single line for bullet, or multi-line indented>
```

Prefer single-line sanitized body (same as today) to keep the trusted block compact.

## Severity floor

Policy no longer supplies `severityFloor`. Review executor always passes `undefined` for policy-derived floor. Existing optional `severityFloor` plumbing in the finding pipeline remains unused by policy (no behavior change for repos that never set it; repos that relied on YAML floor lose that gate — intentional).

## Policy suggestions

**New file** (absent, invalid, or not exactly one match):

````md
Create `.pr-agent/<slug>.mdc` with:

```mdc
---
globs:
  - "<file path or dirname/**>"
alwaysApply: false
---

<dismissal evidence as instruction prose>
```
````

**Append** (exactly one matching rule):

````md
Append this to `.pr-agent/<filename>`:

```md
<dismissal evidence>
```
````

Slug: sanitize basename of finding path (alphanumeric + hyphen), fallback `policy`.

## Constants

| Symbol                               | Value       | Role                     |
| ------------------------------------ | ----------- | ------------------------ |
| `REPO_POLICY_DIRNAME`                | `.pr-agent` | Directory                |
| `REPO_POLICY_EXTENSION`              | `.mdc`      | Extension                |
| `MAX_REPO_POLICY_BYTES`              | 32768       | Aggregate content budget |
| `MAX_REPO_POLICY_FILE_BYTES`         | 8192        | Per-file cap             |
| `MAX_REPO_POLICY_FILES`              | 20          | Max files considered     |
| `MAX_REPO_POLICY_PATH_PATTERN_CHARS` | 200         | Per glob                 |
| `MAX_REPO_POLICY_INSTRUCTION_CHARS`  | 1000        | Per body                 |

Remove: `REPO_POLICY_FILENAME`, `MAX_REPO_POLICY_TONE_CHARS`, `MAX_REPO_POLICY_PATH_INSTRUCTIONS`.

## Docs / ADR

- Update `CONTEXT.md`, `docs/configuration.md`, `docs/operations.md`.
- New ADR `0025-mdc-repo-policy.md`.
- Amend ADR 0023 text only via the new ADR’s relationship note (do not rewrite history).

## Out of scope

- Recursive rule directories
- Auto-committing policy files
- Migrating existing `.pr-agent.yml` contents
- Triage checkout for grounded append (create-new only until triage gains a view)
