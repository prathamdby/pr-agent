# ADR 0053: Prompt module layout

## Status

Accepted. Phase 3 is complete: prompt text lives under `src/prompts/`, the
legacy prompt folders are deleted, and the layout, import, and sink rules
are enabled as errors. [ADR 0052](0052-pr-voice-contract.md) governs output
prose. This ADR governs where prompt text lives.

## Context

Model-facing prompt text was spread across agent and review modules, settings
constants, and run loops. A role's prompt could not be read top to bottom in one
file. Blocks that several roles render had no single home, and nothing stopped
new prompt text from landing anywhere.

## Decision

1. All model-facing prompt text lives under `src/prompts/`. That covers system
   prompts, user-message builders, scripted turns, nudge and repair messages,
   and trust framing inside prompts.
2. These stay where they are:
   - tool descriptions, including `SUBMIT_FINDINGS_REPORT_DESCRIPTION` and
     `SUBMIT_DESCRIPTION_DESCRIPTION`;
   - schema `v.description` text;
   - the generated guest catalogue, `src/agent/codemode/guestCatalogue.ts`;
   - validator and tool-result messages that validators return to the model;
   - `AGENT_FIX_PROMPT_PREAMBLE`, which is published copy.
3. The layout is two levels deep:

   ```
   src/prompts/
     shared/<section>.ts   blocks rendered by two or more roles
     <role>/prompt.ts      the role's text inline, in rendered order
     <role>/<section>.ts   optional role section file
   ```

4. The roles are `correctness`, `security`, `quality`, `tests`,
   `orchestrator`, `ask`, `triage`, `verification`, `description`, `ci`,
   `judge`, and `compaction`. The role is `judge`, not `policy`, so it does not
   clash with repo policy.
5. The section names are a closed set of nine. Where two could fit a block, the
   boundary rule decides.

   | File               | Owns                                                                                                                          | Boundary rule                                      |
   | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
   | `identity.ts`      | Who the role is, its goal, and when it is done                                                                                |                                                    |
   | `behavior.ts`      | Method, discipline, decision gates, severity, verdict meanings, read-only scope                                               | Read-only scope is behavior, not safety            |
   | `safety.ts`        | Trust and data boundaries: untrusted input, outbound data, forged-header handling, and the envelope helpers that enforce them | Envelope helpers sit next to the rule they enforce |
   | `tools.ts`         | How to call tools: harness, native tooling, terminal-call instructions                                                        | Never the shape of what a tool returns or receives |
   | `communication.ts` | Prose style for anything a human reads                                                                                        |                                                    |
   | `output.ts`        | The fields and shape the model returns, including terminal-call payloads and length limits                                    | Verdict-text rules are output, not behavior        |
   | `context.ts`       | Rendering runtime data into messages                                                                                          |                                                    |
   | `examples.ts`      | Worked examples shown to the model                                                                                            |                                                    |
   | `repair.ts`        | Nudges, retry, shorten, and validation-repair messages                                                                        |                                                    |

   There is no per-block placement table. These rules are the whole convention.

6. A block rendered by two or more roles lives in `shared/`. A block rendered by
   one role lives in that role. There are no copies. `shared/` has no
   `prompt.ts`.
7. A role section file may exist only when two or more of the role's exports
   use the block, or when the block is self-contained and over about 40 lines.
   Review enforces this rule.
8. Prompts are pure text. Data fetching, ledger slimming, and fingerprinting
   stay in feature code. Callers pass derived values in.
9. Assemblers reproduce today's arrays, `""` separators, and `.join` calls
   literally. There is no template engine, registry, or compose wrapper.
10. A structure-only move must not change one byte of `nub run dump-prompt all`.
    Run it on the merge base, run it twice on the head, and `cmp` both head runs
    against the base. The PR body carries the commands and results. This keeps
    the stable prefixes of [ADR 0025](0025-prompt-cache-stability.md). No
    baseline is committed.

## Enforcement

The single oxlint JS plugin entry is `scripts/lint/pr-agent.mjs`, named
`pr-agent`. It loads rules from rule modules: `scripts/lint/no-comments.mjs` and
`scripts/lint/prompts.mjs`. oxlint rejects a second plugin with the same name,
so new rules join this entry. `scripts/forcedOxlintConfig.mjs` still strips
`jsPlugins` for the guard counters.

1. `pr-agent/prompt-layout` checks each file under `src/prompts/`:
   - the path is `src/prompts/<dir>/<file>.ts`, no deeper and no shallower;
   - `<dir>` is `shared` or a role from `PROMPT_ROLES`;
   - `<file>` is a section from `PROMPT_SECTIONS` or `prompt.ts`;
   - `shared/` has no `prompt.ts`.
2. `pr-agent/prompt-imports` checks import, re-export, and dynamic import
   edges. It resolves relative specifiers against the importing file.
   - Outside `src/prompts/`, a file under `src/` may import only
     `<role>/prompt.js`, `shared/safety.js`, or a `TRANSITION_IMPORTS` entry.
     `TRANSITION_IMPORTS` is empty. There are no legacy importer exemptions.
     Type-only imports get no exemption here.
   - Inside `src/prompts/`, a file may import other `src/prompts/` files,
     anything type-only, and the modules in `INSIDE_IMPORTABLE_MODULES`:
     `src/settings/*Constants.ts`, `src/settings/index.ts`,
     `src/agent/codemode/guestCatalogue.ts`, `src/util/escape.ts`, and
     `src/github/markdownFormat.ts`. The settings barrel is listed because
     `.pr-agent/esm-imports.mdc` requires
     settings imports to go through it. A path joins this list only with a
     stated reason in its PR. Domain builders stay out.
     The Markdown module provides pure escaping without imports, side effects,
     or I/O, preserving the existing bytes and a single implementation.
   - `shared/` never imports a role directory, not even for types.
   - `test/` and `scripts/` are exempt.
3. `pr-agent/prompt-sinks` checks prompt origins in `src/`, outside
   `src/prompts/`. `test/` and `scripts/` are exempt. Each sink checks only its
   prompt-bearing argument or property, never session options or tool
   descriptions.

   | Sink                                                                         | Prompt value                              |
   | ---------------------------------------------------------------------------- | ----------------------------------------- |
   | `session.send(...)`, `activeSession.send(...)`                               | Argument 0                                |
   | `sendWithRetry(...)`, `runSubmitOnlyRound(...)`, specialist `send(...)`      | Argument 1                                |
   | Object-literal `systemPrompt`, `userContent`, `nudge`, `repairPrompt` fields | Property value                            |
   | Compaction `streamFn(...)`                                                   | `messages[].content[].text` in argument 1 |

   The receiver list is explicit. Queue `boss.send` and IPC `target.send` are
   not prompt sinks. String and template literals are forbidden anywhere in
   a prompt value. `context.sourceCode.getScope` resolves each identifier:
   it must be imported from `src/prompts/`, a prompt parameter of a listed
   wrapper, or a `const` whose initializer passes these same checks
   recursively. This covers prompt export calls, imports, checked carrier
   reads, and conditional selections. Mutable `let` bindings do not pass.
   Runtime identifiers may occur anywhere inside a prompt export's call
   arguments. A conditional checks both value branches, not its test
   expression: the test selects a source but is not sent. `??` and `||`
   check both operands. These checks apply recursively.

   Prompt-field properties establish carrier provenance at their origin.
   A read such as `setup.userContent`, `params.systemPrompt`, or `spec.nudge`
   is allowed because its field value is checked when the carrier object is
   constructed. Calls through `spec.repairPrompt` accept runtime arguments,
   as do arrow-function repair values whose body calls a prompt export.
   Non-prompt fields do not gain this allowance.

   A computed prompt-map read such as `SPECIALIST_SYSTEM_PROMPTS[role]` is
   allowed only when the map is a module-level `const` initialized by an
   object literal. Every map value is checked as a prompt sink, including
   values behind TypeScript `satisfies` or `as` expressions.

   The listed wrappers are `sendWithRetry`, `runSubmitOnlyRound`, specialist
   `send`, `defaultSubmitOnlySend`, `createFeaturePiSession`, and
   `runFeatureAgent`. Their prompt parameters cannot be reassigned, including
   destructuring assignments and writes to their prompt carrier fields.

4. `test/architectureRules.test.ts` holds must-catch and must-allow probes for
   each rule. The probe helper writes nested `src/prompts/<dir>/` paths into a
   temporary tree and runs oxlint with the repository rule config or an
   explicit one.
5. Import edges outside prompts stay rows in `test/architectureRules.test.ts`
   ([ADR 0040](0040-in-repo-import-ruleset.md)).

### Failure modes

1. The plugin entry does not load a rule, or the rule is not enabled, so a bad
   path or edge passes lint.
2. A specifier is matched as text, so `./prompts/` under another folder counts
   as `src/prompts/`.
3. A re-export or dynamic import bypasses the import rule.
4. A type-only edge from `shared/` to a role passes.
5. A sink checks the wrong argument, or mistakes queue or IPC messages for
   prompts.
6. An inline literal, untrusted local alias, or shadowed import passes origin
   checking.
7. A prompt carrier or map hides a literal at its construction site.
8. A wrapper reassigns its prompt parameter after the caller's value passed
   lint.

## Consequences

- A new role or section name needs an edit to `scripts/lint/prompts.mjs` and to
  this ADR.
- The import rule does not see prompt text that flows through allowed imports.
  The inventory and review still catch that.
- A new sink or wrapper needs an explicit rule-table edit and both probe
  directions in `test/architectureRules.test.ts`.
- JS plugins are alpha in oxlint. The version stays pinned exactly, and every
  oxlint bump reruns the probes ([ADR 0051](0051-no-source-comments.md)).
