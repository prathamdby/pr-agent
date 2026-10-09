# ADR 0046: Local agent traces

## Status

Superseded by [ADR 0050](0050-posthog-ai-traces.md). The decision below is the
historical Postgres store. Do not implement it.

## Decision

Record execution, session, generation, tool and compaction spans in the existing
Postgres database. Metadata is the default; content is opt-in. PostHog retains
summary metadata only, with `trace_span_id` linking to local spans.

Execution identity is the durable runner's UUID, not the work item or prompt-cache
identity. AsyncLocalStorage carries execution context. Session children use
explicit parents. Auxiliary CI author and policy judge sessions get standalone
executions when no durable context exists.

Pi agent events own generation and tool timing. TTFT starts at `turn_start`,
before provider authentication and streaming, and ends at the first text,
thinking or tool-call delta.
Reasoning duration covers first through last thinking delta. Generations end at
`message_end`, before tools run. Provider-client retries remain folded and
unobservable; reports exclude folded calls from model-latency rankings.
Stream invocations count provider attempts, never measure agent generation timing.
Compaction has its own span and usage, outside normal model-latency rankings.

Cost is unknown when catalog prices are missing or all zero. Pi's computed usage
cost is catalog-sourced, not an independently reported provider bill. Unknown
cost is NULL and absent from cost rankings.

The worker uses a separate two-connection pool, a bounded span queue and bounded
content bytes. Flushes run every 500 ms or at 200 spans. Agent execution never
awaits a trace write. Failed or overflowed spans are lost, counted and logged.
One metadata-only `trace_spans_dropped` event reports each execution's losses.
Shutdown uses the existing bounded reserve alongside analytics.

The worker execution layer creates and owns the dedicated pool and injects it
into recording. Its finalizer drains recording, ends the pool and closes any
checked-out trace sockets left at the cutoff. The durable work pool is separate.
Pi callers receive an always-present, nonthrowing observer. Disabled recording
uses an inert observer; failure isolation stays inside that module. Execution
counters and mutable recorder state stay private, and analytics reads only a
scalar correlation identifier. No interchangeable storage interface is needed
for the single Postgres implementation.

Content parts are credential-redacted and content-addressed. Generations retain
only input changes since their previous turn; compaction resets that input basis.
Oversized content is explicitly truncated. Dumps use dynamically sized untrusted
fences, so stored text cannot close the fence. Trace content remains untrusted
evidence, never instructions, publication receipts or recovery authority.
Generation `attrs.input_parts` separates input from output parts. `input_reset`
marks the post-compaction input basis, including retained assistant messages.

Retention deletes aged spans and cascading parts in batches, then unreferenced
aged blobs. Shared blobs cannot be removed while a retained part refers to them.
Trace retention cannot exceed work retention. Disabling the retention schedule
also disables automatic trace cleanup.

## Failure modes recorded before implementation

1. Tracing errors, pool exhaustion or shutdown delays fail or block agent work.
2. Unbounded content, queued writes or execution counters exhaust a small host.
3. Specialist concurrency cross-links sessions or mixes execution identities.
4. Tools inflate generation latency or deltas record the wrong TTFT.
5. Hidden retries masquerade as model latency or missing prices become zero cost.
6. Compaction loses prompts, usage, parentage or the next input-delta baseline.
7. Configured credentials, escaped secrets or private-key blocks reach storage.
8. Stored prompt injection escapes transcript fences or leaks into PostHog.
9. Retention races writes, removes referenced blobs or leaves orphan parts.
10. Cancellation, thrown providers and deferred cleanup leave unlabelled spans.
11. Schema rejection, tool budgets and Code Mode halts go missing from signals.
12. Disabled tracing still stores content or opens an extra database pool.

## Verification

Use existing suites and disposable Postgres. Preserve metadata/content dumps,
model and signal reports, and the `nub run verify` artifact. No new test files.
The repository verify command exercises durable integration with fake sessions;
it does not itself run a live-model review. Record that limitation with measured
artifact sizes rather than claiming live-model latency evidence.

The production Pi session implementation was exercised against in-process
simulated OpenAI Responses SSE, without external provider calls. Each mode
recorded 11 sessions, 15 generations and six tools under one execution,
including all four specialists and every feature role. Metadata mode retained
no parts. The simulated content run retained 79 parts, 7,627 referenced UTF-8
bytes and 19 redactions. This is a small runtime proof, not a live review's
storage estimate.

Artifacts remain local under `verify-artifacts/`: `traces-runtime-proof.json`,
`traces-metadata-report.json`, `traces-content-report.json`,
`traces-content-dump.md`, and the successful disposable integration artifact
`2026-10-06T06-00-05-723Z.md` (639 integration cases). The full unit suite passed
2,748 cases. Live-model review cost, latency and bytes-per-review remain unmeasured.

`traces-boundary-proof.json` records a separate disposable-Postgres probe of
compaction and its adopted assistant input, unknown costs, credential redaction,
repair and budget signals, off mode, bounded pending content, overflow counts,
deduplication, referenced-blob retention, cascades and denied trace writes.

The architecture rework was checked through the worker execution layer and its
session observer with disposable Postgres. `traces-design-runtime-proof.json`
records metadata/content sessions for four concurrent specialists, safe observer
failures, compaction and off mode. A blocked insert reached the 5,009 ms drain
cutoff; process-owned database sockets fell from three to the two proof sockets,
while the held work connection stayed usable. Postgres can retain a waiting
backend until the lock wait wakes; it disappeared after the proof released its
lock. This probe uses synthetic Pi events, not live-provider measurements.
