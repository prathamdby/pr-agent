# ADR 0050: PostHog AI traces

## Status

Accepted. Supersedes [ADR 0046](0046-agent-traces.md).

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
behind `[trace content truncated]`. An event that still does not fit is dropped
and logged, with no content in the log. The worker queues at most 400 spans and
8 MiB. Bytes stay counted until the client's flush settles. Flush interval is 0
on the AI client so the recorder owns the batch. Send failure is a warning and
does not change the durable outcome.

The AI client does not use the product analytics `before_send` sanitizer, which
would strip tool bodies. It sets `$process_person_profile` false. Credential
redaction still runs on trace content. Ordinary product events stay metadata
and do not include prompts or tool payloads.

An empty token records nothing and opens no trace client. The web process does
not emit traces. There is no local content mode and no metadata-only mode.

`TRACES_MODE`, `TRACES_RETENTION_SECONDS`, and `TRACES_BUFFER_MAX_SPANS` fail
startup and name the variable. Migration 040 drops the trace tables. The drop
sets a 3 second lock timeout because it locks `agent_work_items`.

This is a breaking privacy change. An install that already has a PostHog token
now sends repository text to that project. Removing the token is the opt-out.
PostHog keeps AI event content for 30 days. Model, tokens, latency, and ids
remain after that. AI events are billed and do not update person profiles.

Traces are not recovery evidence.

## Consequences

Delete the three `TRACES_*` variables before upgrade, or web and worker both
refuse to start and GitHub will not redeliver the in-flight webhook. Upgrade
both processes together. Query `posthog.ai_events`. Dashboards that used the
work item as `$ai_trace_id`, or the Pi session id as `$ai_session_id`, need to
use the execution id and the work item id.
