# ADR 0010 — `/ask` red-team hardening

## Status

Accepted.

## Context

The `/ask` command ([ADR 0008](0008-ask-command.md)) runs a tool-loop agent over PR code. Comment text, diff hunks, and tool output can carry prompt-injection or exfiltration attempts. Prior defenses were prompt-only ("do not paste secrets") with no outbound redaction ([README](../../README.md) noted no deterministic redaction in v1).

Review runs must remain unchanged; `/ask` must still answer normal code questions, including security vocabulary and env-var usage in the repository under review.

## Decision

Layer ask-only defenses (always on, no feature flag):

1. **`bot_meta` short-circuit** — Narrow heuristics detect questions targeting bot configuration, credentials, or internal instructions. Return a canned **Ask meta refusal** without calling the LLM. Cross-repo escape attempts are **not** short-circuited; they hit scoped tools instead.

2. **Untrusted data framing** — User questions and code anchors are wrapped in labeled blocks; the system prompt treats PR/tool content as untrusted data.

3. **Scoped GitHub tools** — Ask runs use `buildAskGithubTools`: force `owner`/`repo`/`pullNumber`, inject `repo:owner/repo` into `searchCode`, default `getFileContent` ref to head SHA, redact emails in `getBlame` results.

4. **Sensitive path gate** — Block `getFileContent` on denylisted paths (`.env`, `*.pem`, etc.) unless the path appears in this PR's changed-files list.

5. **Outbound redaction** — `sanitizeAskAnswerText` redacts bot/host secret formats before posting. The same public-output redactor (`redactOutboundSecrets` / `redactReviewText`) also runs on triage report bodies at the report-upsert chokepoint. Logging and analytics use the canonical recursive telemetry sanitizer (`sanitizeTelemetryValue` plus `serializeAppError`) at their facades, covering camel- and snake-case messages, contexts, raw values, causes, arrays, objects, and circular references; `sanitizePostHogEvent` remains the final `before_send` backstop for explicit and autocaptured exceptions. Log truncation (`sanitizeLogMessage`) is not used on these paths.

6. **Input bounds** — `/ask` questions capped at 8192 characters.

7. **Log sanitization** — Failure logs use `sanitizeLogMessage` for stdout fields.

## Consequences

- Obvious meta probes cost no LLM tokens and cannot paraphrase guardrails.
- Collaborators who can comment can still read the repo via GitHub; the bot is not a new authorization boundary ([issuer authz out of scope](0008-ask-command.md)).
- Prompt injection in PR diffs is mitigated, not eliminated; framing + tool scoping limit blast radius.
- Ask defenses stay ask-scoped; shared outbound redaction additionally covers triage GitHub comments, structured logs, and PostHog analytics without changing review publish behavior.

## Reversal

Remove `askSafety` usage from `askRun.ts`, restore flat user messages and unscoped `buildGithubTools`, revert `formatAskReply` redaction. Remove triage report `redactReviewText` at upsert and PostHog `before_send` sanitization if those boundaries are no longer required.
