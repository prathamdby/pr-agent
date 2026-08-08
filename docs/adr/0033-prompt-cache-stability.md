# ADR 0033: Prompt cache stability for Pi agent sessions

## Status

Accepted. Extends [ADR 0031](0031-pi-native-agent-runtime.md).

## Context

Orchestrated reviews and specialist runs spend heavily on repeated system prompts
and tool definitions. Provider prompt caching was an inherited pi-ai default, not
a product contract. Mid-session active-tool mutation and short-job auto-compaction
break conversation prefixes. Operators could see raw cache token counts on a
completed review run, but not whether caching was actually good.

Anthropic-style caching keys primarily on stable content prefixes (system and
tools). OpenAI-compatible providers also use a `prompt_cache_key` derived from the
session id. Minute-scale review jobs do not justify long (1h/24h) cache write
premiums by default.

## Decision

1. **Stable system + tools per session.** A Pi session registers its full tool
   definition set once at create time. Phase safety for the orchestrator is
   enforced in tool executors (phase → allowed tools), not by swapping the active
   tool list mid-session.
2. **Explicit short retention.** The runtime seam injects
   `cacheRetention: "short"` on every provider stream entry. Do not rely on
   ambient `PI_CACHE_RETENTION` folklore. Long retention is out of scope as the
   default.
3. **Role-scoped OpenAI cache identity.** In-memory sessions use a stable id built
   from role, optional specialist id, provider, and model, clamped to provider
   prompt-cache key length limits, so equivalent prefixes can share OpenAI cache
   keys across jobs when content matches.
4. **Compaction by role.** Auto-compaction stays off for orchestrator, specialist,
   and CI summary (minute-scale, high tool churn). It remains available for ask,
   triage, description, and verification. Controlled compaction APIs with no
   production callers are deleted rather than wired “just in case.”
5. **Measurable hit rate.** Review-run completed metrics expose cache hit rate and
   cache write amplification when provider usage totals are known, while preserving
   raw cache read/write totals and any provider-reported 1h cache write split.

Feature harnesses keep using the single Pi session seam from ADR 0031. No generic
prompt-caching framework and no deferred-tool subsystem for this change.

## Consequences

- Policy lives in `src/agent/runtime/promptCachePolicy.ts` (retention + session
  cache id), role compaction in `compactionPolicy.ts`, and orchestrator phase
  allowlists in `src/review/orchestrator/phaseToolPolicy.ts`.
- Orchestrator and specialist tool JSON must stay byte-stable across phases and
  personas (persona differences live in system prompts only). Shared code-index
  description/schema and specialist tools are registered once at session create.
- Wrong-phase `brief` / `publish_thread` / `publish_summary` calls return
  structured executor errors; the registered tool list does not change mid-session.
  Mid-session `setActiveTools` / `transitionTools` APIs are gone.
- Auto-compaction stays off for orchestrator, specialist, and CI summary; ask,
  triage, description, and verification keep role-based compaction. Unused
  controlled-compaction APIs with no callers stay deleted.
- `review_run_completed` carries `cacheHitRate`, `cacheWriteAmplification`,
  raw cache read/write totals, and optional `cacheWrite1hTokens` when the provider
  reports a 1h write split. Operators read cache quality without manual ratio
  arithmetic (see [operations.md](../operations.md)).
- Anthropic deployments benefit mainly from stable tools and disabled short-job
  compaction; OpenAI-compatible deployments also benefit from stable session ids.

## Alternatives considered

- **Keep tool-list mutation; only add metrics** — leaves the main Anthropic cache
  bust in place; rejected.
- **One fresh session per orchestrator phase** — correct prefixes but colder
  caches and more create overhead; rejected for excellence.
- **Default long retention** — pays write premiums for idle post-job cache on
  minute-scale reviews; rejected unless later measurement shows cross-job hits
  worth the cost.
