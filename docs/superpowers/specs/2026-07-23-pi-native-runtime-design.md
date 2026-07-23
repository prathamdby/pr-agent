# Design: Pi-native agent runtime (issue #341)

## Status

Accepted for planning (autonomous decisions locked). Source of truth for product requirements: GitHub #341 and sub-issues #342–#351. This document records delivery decisions and concrete interfaces for implementation.

## Goal

Replace the dual Cursor/Pi `AgentRunnerProvider` abstraction with one Pi-specific session seam owned by pr-agent. Remove the Cursor SDK and exclusive dependencies. Add sanitized lifecycle events, role-based model policy with availability fallback, phase-aware thinking, policy-controlled compaction, durable Agent phase checkpoints with operation intents, and short-lived encrypted resume snapshots — without weakening the worker trust boundary or publish-record authority.

## Locked delivery decisions

| Topic | Choice |
| --- | --- |
| Landing | **One branch / one PR** (`pd/feat/pi-native-runtime`) covering #342–#351 |
| Order | Parent staging: guard → seam → events/policies → durability → call-site migration → Cursor removal. **Durability (#348/#349) before #350** even though the issue graph omits that edge |
| ADR 0031 | **Create in-repo** as Accepted; supersede ADR 0013 and the runner-selection portion of ADR 0015 |
| Git ops | Always via **prath-mode** (`commit` / `deslop` / `make-pr` leaves) |
| Subagents | Implementer **Composer 2.5**; reviewer **Grok 4.5** when Task/orchestrate is available; main agent verifies |

## Approaches considered

1. **Expand-then-contract on one PR (chosen)** — Add migration guard + Pi seam beside `AgentRunnerProvider`, migrate call sites, then delete Cursor. Lowest migration risk; large PR.
2. **Staged PRs** — Safer review bites; rejected by user (chose A).
3. **Big-bang delete Cursor first** — Forces immediate rewrite of all harnesses; highest breakage risk. Rejected.

## Architecture

```text
Feature harnesses (orchestrator, specialist, ask, …)
        │
        ▼
  PiSessionFactory / PiSession  ←── only shared test seam
        │                         (fake in tests)
        ▼
  src/agent/runtime/*  (sanitizer, policies, compaction, fallback)
        │
        ▼
  @earendil-works/pi-coding-agent  (raw events stay here)

Durable side:
  agent_phase_checkpoints + operation_intents + agent_resume_snapshots
  publish_records remain authoritative for GitHub mutations
```

### Module layout (new)

| Path | Responsibility |
| --- | --- |
| `src/agent/runtime/types.ts` | Roles, model assignment, policies, send options, lifecycle event union |
| `src/agent/runtime/piSession.ts` | `PiSession` interface + factory |
| `src/agent/runtime/piSessionImpl.ts` | Wraps current Pi SDK (`createAgentSession`) |
| `src/agent/runtime/fakePiSession.ts` | Test double |
| `src/agent/runtime/lifecycleEvents.ts` | Discriminated event types |
| `src/agent/runtime/lifecycleSanitizer.ts` | Allowlist + redaction |
| `src/agent/runtime/agentAudit.ts` | Metadata-only audit records from sanitized events |
| `src/agent/runtime/modelPolicy.ts` | Orchestrator/general/fallback resolution + one-model-per-session |
| `src/agent/runtime/fallbackClassification.ts` | Eligible vs ineligible failure categories |
| `src/agent/runtime/thinkingPolicy.ts` | Phase → thinking level + clamp/ceiling |
| `src/agent/runtime/compactionPolicy.ts` | Threshold, safe boundaries, re-inject instructions |
| `src/agent/runtime/checkpoints.ts` | Phase checkpoint types + repository API |
| `src/agent/runtime/operationIntents.ts` | Idempotent mutation intents |
| `src/agent/runtime/resumeSnapshots.ts` | Encrypt/decrypt + retention |
| `migrations/016_agent_runtime_durability.sql` | New tables |
| `docs/adr/0031-pi-native-agent-runtime.md` | Architecture decision |

Keep `src/agent/providers/pi/index.ts` during expand; fold into `piSessionImpl` during #350/#351. Delete `src/agent/providers/cursor/**` in #351.

### Pi session seam (core interface)

```ts
type AgentSessionRole =
  | "orchestrator"
  | "specialist"
  | "ask"
  | "description"
  | "triage"
  | "verification"
  | "ci_summary";

type ModelAssignment = {
  readonly provider: string;
  readonly model: string;
};

type AgentSessionPhase =
  | "recon"
  | "specialist"
  | "judgment"
  | "synthesis"
  | "validation_repair"
  | "publish_recovery"
  | "ask"
  | "description"
  | "triage"
  | "verification"
  | "ci_summary";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type PiSessionCreateParams = {
  readonly role: AgentSessionRole;
  readonly primary: ModelAssignment;
  readonly fallback?: ModelAssignment; // used only via fresh-session recovery
  readonly thinkingPolicy: ThinkingPolicy;
  readonly compactionPolicy: CompactionPolicy;
  readonly toolPolicy: ToolPolicy; // server custom tools only; builtins off
  readonly structuredState: AuthoritativeStructuredState;
  readonly systemPrompt: string;
  readonly cwd?: string;
  readonly eventSink: (event: AgentLifecycleEvent) => void;
  readonly cfg: Config;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
};

type PiSessionSendOptions = {
  readonly phase: AgentSessionPhase;
  readonly maxToolRounds?: number;
  readonly deadlineMs?: number;
  readonly checkpointId: string; // last safe Agent phase checkpoint identity
};

type PiSession = {
  readonly send: (prompt: string, opts: PiSessionSendOptions) => Promise<AgentRunnerTurn>;
  readonly setActiveTools: (
    tools: readonly PiTool[],
    executors: Record<string, AgentRunnerToolExecutor>,
  ) => void;
  readonly restoreTools: () => void;
  readonly abort: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly restartWithFallback: (params: {
    readonly checkpointId: string;
    readonly structuredState: AuthoritativeStructuredState;
  }) => Promise<PiSession>;
};
```

During expand (#343), keep `AgentRunnerProvider` working. Optionally add a thin adapter `AgentRunnerProvider` → `PiSession` for gradual migration, but call sites must move to `PiSession` by #350.

### Lifecycle events + audit

Allowlisted discriminated union kinds: `turn`, `tool`, `retry`, `compaction`, `usage`, `cancellation`, `completion`, `failure`.

Fields limited to ids, role, phase, counts, durations, stable `AppError.code` / classified failure kinds, model assignment ids (provider/model names only), compaction reason, tool **names** (never args/results).

Sanitizer rejects or strips: prompts, model text, reasoning, tool payloads, arbitrary exception messages, credentials, installation tokens, repository content. Reuse `sanitizeLogMessage` / PostHog sanitizer patterns.

Audit records: append-only metadata derived from sanitized events; reuse `classifyFailure` taxonomy.

### Model policy

| Setting | Env | Default |
| --- | --- | --- |
| General primary | `PI_PROVIDER` / `PI_MODEL` | existing defaults |
| Orchestrator primary | `PI_ORCHESTRATOR_PROVIDER` / `PI_ORCHESTRATOR_MODEL` | fall back to general primary when unset |
| Shared fallback | `PI_FALLBACK_PROVIDER` / `PI_FALLBACK_MODEL` | unset = fallback disabled |

Roles: orchestrator → orchestrator primary; all other sessions → general primary.

Fallback eligibility (after normal retry budget exhausted): transient transport, exhausted rate limit, provider 5xx, explicit model-unavailable.

Ineligible (existing failure paths): auth, config, invalid-request, context-limit, tool, validation, internal, cancellation, deadline.

Recovery: dispose failed session; create **new** session with fallback model from latest committed checkpoint + authoritative structured state. Never mid-session model switch on a healthy session.

### Thinking policy

Map `AgentSessionPhase` → desired level:

| Phase | Default level |
| --- | --- |
| `validation_repair`, `synthesis`, `publish_recovery` | `low` / `off` |
| `recon`, `specialist`, `judgment` | `medium` (clamp under ceiling) |
| ask/description/triage/verification/ci_summary | `low` |

Ceilings via `PI_THINKING_CEILING` (default `high`). Clamp to nearest model-supported level; never throw on unsupported.

### Compaction

Enable Pi auto-compaction near context limit via settings (`compaction.enabled: true`) with server-owned custom instructions. Gate: only after turn settles and no unresolved external mutation (pending operation intent). After compaction, re-inject authoritative structured state (specialist reports, accepted findings, publish ledger summary ids, phase checkpoint, remaining work). Compaction summary is advisory only.

### Durability

**Migration `016_agent_runtime_durability.sql`:**

1. `agent_phase_checkpoints` — keyed by `work_item_id` + `session_role`; stores phase id, structured state jsonb, version, timestamps.
2. `operation_intents` — stable `operation_key`, work_item_id, mutation kind, status (`pending`/`reconciled`/`failed`), link to publish_records, timestamps.
3. `agent_resume_snapshots` — envelope columns (tenant/installation id, model assignment, sdk/prompt/tool-policy versions, checkpoint id, expiry, nonce, ciphertext, auth tag, timestamps). **No plaintext conversation columns.**

**Encryption:** AES-256-GCM. Master key from `AGENT_RESUME_SNAPSHOT_KEY` (base64 32-byte key). Tenant binding via HKDF-SHA256 with `installation_id` as info/salt. Missing key in production worker: startup error when snapshots enabled; for tests use fixture key.

**Retention:** `snapshot_ttl_seconds = queue_retry_window + margin` where retry window is derived from `QUEUE_RETRY_LIMIT` × capped exponential backoff (use `QUEUE_RETRY_DELAY_MAX_SECONDS * QUEUE_RETRY_LIMIT` as upper bound) + `QUEUE_EXPIRE_IN_SECONDS` safety? Spec: cover full queue retry window + bounded margin. Implement helper `computeResumeSnapshotTtlSeconds(cfg)` with margin default 600s (`AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS`).

Terminal work states delete snapshots early (completed/cancelled/superseded + retention job).

### Trust boundary (unchanged product rules)

- Disable Pi builtin shell/write/edit/filesystem tools (`noTools: "builtin"`).
- Empty skills/extensions/prompts overrides; no project resource discovery from reviewed repo.
- Agent instruction files + repo policy rules remain untrusted prompt text via existing trusted-context construction.
- Server-defined custom tools only.

### Cursor removal (#342 then #351)

#342 first: `loadConfig()` / boot throws `AppError` code `config.cursor_provider_removed` when `AGENT_PROVIDER=cursor` (or legacy cursor-only keys that would have selected Cursor). Message names `AGENT_PROVIDER` and points to Pi catalog + role-based model envs. Do **not** map `CURSOR_API_KEY` into Pi.

#351 last: delete cursor sources/tests/fixtures/constants/env keys; remove `@cursor/sdk`, `@modelcontextprotocol/sdk`, `sqlite3` onlyBuiltDependencies; remove `AgentRunnerProvider` + resolver; update AGENTS.md / configuration / development / operations; mark ADR 0013 superseded; dependency-inventory tests.

### Documentation (same PR)

- Create ADR 0031
- Update CONTEXT.md only if new vocabulary is introduced (Pi session seam, Agent phase checkpoint, resume snapshot, operation intent — add if not already present)
- Update `docs/configuration.md`, `docs/development.md`, `docs/operations.md`, README topology if worker boot changes
- Commit this design to `docs/superpowers/specs/2026-07-23-pi-native-runtime-design.md` and plan to `docs/superpowers/plans/2026-07-23-pi-native-runtime.md`

## Testing strategy

Prefer harness/seam tests over SDK call-order assertions. Fake `PiSession` covers sends, tools, events, compaction boundaries, checkpoint recovery, fallback restart, abort, dispose.

Must-have suites per sub-issue acceptance criteria (config migration, dependency inventory, model policy, fallback tables, lifecycle contract, trust boundary, compaction harness, snapshot crypto, crash-window publish intents, feature call-site suites green).

Final gate: `nub run check:code`, `nub run test`, production build.

## Out of scope

As in #341: repo-loaded Pi resources, builtin write/shell tools, indefinite session archive, raw stream publishing, mid-session model switch on healthy sessions, fallback for non-availability failures, replacing publish_records with Pi persistence, changing orchestrator/specialist product model, reintroducing generic multi-runner framework.

## Self-review

- No TBD placeholders for interfaces or env names.
- #350 explicitly waits on #348/#349 by delivery decision (stronger than issue graph).
- ADR 0031 created in this work.
- Scope matches #341; no second runner abstraction.
