# ADR 0050: PostHog AI traces

## Status

Accepted. Supersedes [ADR 0046](0046-agent-traces.md).

> **Changelog:** 2026-10-09, startup does not read `TRACES_MODE`,
> `TRACES_RETENTION_SECONDS`, or `TRACES_BUFFER_MAX_SPANS`.
> 2026-10-14, Code Mode `tool:execute` spans carry `codemode_host_calls`. See
> [Code Mode host calls](#code-mode-host-calls).
> 2026-10-14, overflow degrades to a metadata-only event instead of dropping,
> and session, generation, execution, and specialist spans carry loop, cutoff,
> and loss fields. See [Loop, cutoff, and loss fields](#loop-cutoff-and-loss-fields).
> 2026-10-14, generations use PostHog's message shape, tool spans carry bounded
> input, output, and code hashes, and a cancelled session records the last
> turns and any partial findings. See
> [Diagnosable model and tool content](#diagnosable-model-and-tool-content).

## Context

ADR 0046 stored execution, session, generation, tool, and compaction spans in
Postgres, with content as an opt-in mode. A second projection sent metadata-only
`$ai_generation` and `$ai_span` events to PostHog and used the work item as the
trace id. Operators who wanted the transcript had to query Postgres. Operators
who used PostHog never saw the prompt, the reasoning, or the tool result.

The Postgres store also capped each part at 64 KiB and each span at 256 KiB.
A full input copied onto a generation could fill that cap and drop later text
and reasoning without a truncation marker.

## Decision

PostHog is the only trace store. Postgres stores none of the transcript.

A configured `POSTHOG_PROJECT_TOKEN` makes the worker send one AI trace per
execution. The execution id is `$ai_trace_id`. The work item id is
`$ai_session_id`, or null when the session is not durable work. Specialist,
tool, compaction, and publish spans parent to that execution. Each retry is a
new trace under the same work item. The model is on every AI event.

Content properties are `$ai_input`, `$ai_output_choices`, `$ai_input_state`,
`$ai_output_state`, and `$ai_tools`. Each generation carries the transcript the
observer has seen, not a delta of the latest message. Thinking is an output
choice. Tool arguments and results are input and output state. Cost is omitted
when the catalog price is missing or zero. Provider retries stay one generation.
`$ai_is_error` is set only for a real error. Cancellation stays `status:
cancelled`.

Each event is measured as `Buffer.byteLength(JSON.stringify(event))` after
redaction and must be at most 1 MiB. The fit order keeps identity, then output
choices, then tool definitions, then input. Middle input messages are elided
behind `[trace content truncated]`. An event that still does not fit is sent
metadata-only (see below). The worker queues at most 400 spans and
8 MiB. Bytes stay counted until the client's flush settles. Flush interval is 0
on the AI client so the recorder owns the batch. Send failure is a warning and
does not change the durable outcome.

The AI client does not use the product analytics `before_send` sanitizer, which
would strip tool bodies. It sets `$process_person_profile` false. Credential
redaction still runs on trace content, including GitHub user and refresh
tokens, npm tokens, and mongodb or redis URLs with a password. Ordinary
product events stay metadata and do not include prompts or tool payloads.

An empty token records nothing and opens no trace client. The web process does
not emit traces. There is no local content mode and no metadata-only mode.

Migration 040 drops the trace tables. The drop sets a 3 second lock timeout
because it locks `agent_work_items`.

This is a breaking privacy change. An install that already has a PostHog token
now sends repository text to that project. Removing the token is the opt-out.
PostHog keeps AI event content for 30 days. Model, tokens, latency, and ids
remain after that. AI events are billed and do not update person profiles.

Traces are not recovery evidence.

### Code Mode host calls

A specialist's reads and searches run as host calls inside one `execute`
script, so tool arguments and results alone did not show them. Each
`tool:execute` span now carries `codemode_host_calls`, one entry per admitted
call: tool, input, status, duration, error kind, output bytes, and an output
preview. A call still running when the script ends is `in_flight` with its
elapsed time. Inputs are capped at 2,048 characters and previews at 4,096.
Redaction runs on the preview plus 8,192 characters of lookahead before the
cut, so a credential block that starts inside the preview is matched whole.
The fit order elides input, then shrinks host-call previews, then replaces
host calls with the marker, then continues with tool definitions.

The record is trace-only. It never enters lifecycle events or `agent_events`,
and the result the model sees is unchanged. A failing tracer does not change a
Code Mode result.

Failure modes recorded before implementation: the tracer throws into the
bridge; host content reaches lifecycle events or `agent_events`; a secret
survives a truncated preview; a call still running at script end is lost; the
event exceeds 1 MiB; the model-visible result changes.

### Loop, cutoff, and loss fields

A specialist that loops or hits its deadline used to leave only timing. The
session span now carries `turns`, `tool_calls`, `host_calls`,
`repeat_host_calls`, `repeat_top`, `repeat_tool_calls`, `tool_ms_total`,
`model_ms_total`, `ms_since_last_activity`, `last_tool`, `last_end`, and the
raw `error_code`. A repeat is a host call whose tool name and SHA-256 of its
redacted input match an earlier call in the same session. `repeat_top` lists
the three most repeated host tools as `tool:hash:count`. `hash` is the first
12 hex characters of that SHA-256, and the field has no input text.
`repeat_code_top` is `hash:count` for repeated `execute` scripts, hashed from
the redacted `code` string. `ms_since_last_activity` counts from the last
streamed token, delivered message, tool end, or host call, so a cutoff does
not reset it.

Each generation carries `turn_index`. A generation cut off before a final
message, or ended with an empty one, keeps the text and reasoning streamed so
far and sets `partial=true`.

On overflow the recorder sends the event metadata-only instead of dropping it:
content properties are removed, strings longer than 256 characters become the
marker, and `trace_content_dropped=true` is set. Overflow events use a separate
reserve of 50 events and 64 KiB, so full-content traffic cannot use it up. The
execution span carries no content and goes to the reserve unchanged when the
main queue is full. An event that does not fit the reserve is dropped. The
execution span reports `trace_events_dropped`, `trace_events_degraded`, and
`trace_events_truncated` for its trace.

The specialist `run` span carries `classification`, `attempts`, and
`deadline_hit` for a failed run. These are metadata and also reach
`agent_events`.

Failure modes recorded before implementation: a loop through `execute` goes
undetected; an aborted generation loses its text; normal traffic uses up the
reserve; the execution span is dropped; the specialist span loses its
classification.

### Diagnosable model and tool content

PostHog's conversation view reads `$ai_output_choices` as a list of messages
with `role` and `content`. A flat list of text and tool-call parts has no
`content`, so the generation renders empty. Each choice is now one assistant
message. Text and thinking stay content parts. A model tool call is a
`function` part whose `function.arguments` include the script or other
arguments. `$ai_input` is the same message shape: system, user, assistant, and
tool results (`tool_result` on a user message). `$ai_tools` uses PostHog's
function-tool shape.

Tool spans keep `$ai_input_state` and `$ai_output_state`. Each string in those
bodies is capped (8,192 characters for message text, 16,384 for a tool body,
24,576 for a system prompt) and a cut ends with `[trace content truncated]`.
Redaction runs on the whole value before the cut. The span also carries
`input_sha256` of the redacted arguments and, when the arguments include a
`code` string, `code_sha256` of that redacted script. Host-call entries carry
`input_sha256` of the redacted host input. A cancelled tool with no result
records `{ status: "cancelled" }` instead of an empty output.

`$ai_error` is `{ code, message }` when the failure has both. Cancellation
stays `status: cancelled` and does not set `$ai_is_error`.

A session that ends cancelled or failed puts a bounded diagnosis on the
session span: `$ai_input_state.last_turns` (the last six messages),
`$ai_input_state.partial_findings` (file, title, severity, lines, and a short
detail from any `findings` array the model had already produced), and
`$ai_output_state` with `why` (status, code, message, last end) and `last_tool`
(name, hashes, and the bounded input and output). These fields are how a
specialist that runs to its deadline without `submit_findings_report` is
explained from PostHog. Run-health counters on that same span are the measured
totals, including `tool_ms_total` and `model_ms_total`.

A tool argument object used to skip string truncation. One large `execute`
script then pushed the generation over 1 MiB and the recorder removed both
`$ai_input` and `$ai_output_choices`. Bodies are bounded before emit. The fit
path still shrinks nested `content` and object `arguments` before it gives up
and sends the event metadata-only.

A circular tool result is redacted as the truncation marker. The tracer still
does not throw into the review, and it does not change the value the model
sees.

Failure modes recorded before implementation: output choices without `role`
and `content` render empty; an object tool argument strips the generation; a
repeated script has no hash; a deadline inside `execute` drops the script and
any drafted findings; an error is only a code; a cut or a cycle leaks a secret
or throws; run-health counters stay zero after real work.

## Consequences

Upgrade both processes together. Query `posthog.ai_events`. Dashboards that used the
work item as `$ai_trace_id`, or the Pi session id as `$ai_session_id`, need to
use the execution id and the work item id.

## Amendment (2026-10-17): workspace checkout fields

The `execution` span carries the workspace checkout fields from
`src/prWorkspace/checkoutTelemetry.ts`: `workspace_checkout_mode`,
`workspace_fallback_reason`, `workspace_checkout_reused`,
`workspace_fetch_attempts`, and `git_*` for the last fetch attempt. A sparse
fallback adds `fallback_git_*` for the failed full attempt. Git stderr is not
sent. `annotateExecution` merges these fields and never throws. A failed
execution whose error is an `AppError` sets `$ai_error` to `{ code, message }`.
`"work completed"` and `"work item retried"` carry the same fields.
