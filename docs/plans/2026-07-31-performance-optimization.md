# Performance optimization plan

## Goal

Reduce cold-start latency (especially `ROLE=web`), Postgres boot/query overhead, and worker setup CPU (symbol index / FTS), with **zero functional regressions**. Produce before/after benchmarks from the same workloads.

## Environment (baseline machine)

- Linux 6.12.94+, Node v22.22.2 (nub), 4 CPUs, 15 GiB RAM
- Date: 2026-07-31
- Workloads are local microbenchmarks (no GitHub/LLM credentials required)

## Baseline evidence

### Dependency import cost (cold process, mean of 5)

| Module | Mean ms |
| --- | ---: |
| `effect` | 258 |
| `@effect/platform-node` | 510 |
| `@earendil-works/pi-ai` | 176 |
| `@earendil-works/pi-coding-agent` | 664 |

### App module import (nub, median of 5)

| Entry | Median ms | RSS (median MiB) |
| --- | ---: | ---: |
| `src/config.ts` | 492 | 180 |
| `src/agentWork/runtime.ts` | 772 | 225 |
| `src/worker.ts` | 984 | 244 |
| `src/effect/server.ts` | 1062 | 287 |

### Static import graph

`src/effect/server.ts` reaches **254 modules**, including `agentWork/worker.ts`, all executors, and `review/orchestrator/*`, because `agentWork/runtime.ts` statically imports `AgentWorkerLive`. Web never needs that graph at request time.

### Other measured/structure hotspots

1. `loadConfig()` always calls `assertPiModelSelection` → `ModelRuntime.create` when `models.json` exists (`src/settings/modelsJson.ts`), including for `ROLE=web`.
2. `runMigrations` issues one `SELECT` per migration file (20 today) under an advisory lock (`src/db/migrations.ts`).
3. pg-boss opens a **second** pool (`connectionString` only; default max 10) alongside app pool max 10 (`src/agentWork/boss.ts`, `src/db/postgres.ts`).
4. `buildSymbolIndex` reads files sequentially (`src/prWorkspace/symbolIndex.ts`).
5. `searchCodeIndexFts` evaluates `plainto_tsquery` twice per row ranking (`src/codeIndex/search.ts`).

## Success criteria

1. Web import graph excludes worker/executors/orchestrator/Pi session modules.
2. Web cold module-load time for the webhook entry path improves by a clear, reproducible margin vs baseline (target: ≥25% reduction on `effect/server` equivalent graph, or ≥40% reduction on worker/orchestrator subgraph presence).
3. Migration no-op (already-applied schema) uses O(1) version lookup round-trips, not O(n files).
4. Symbol index build on a synthetic 1k-file tree is faster with concurrency; results identical to sequential.
5. Code-index FTS SQL computes the tsquery once; behavior unchanged.
6. Existing unit tests (`nub run test`) pass; integration tests pass when Postgres is available.
7. No webhook/intake/publish semantics change; Config fields for worker remain validated.

## Out of scope (this pass)

- Role-specific Docker images / removing Pi from the web image
- Sharing one Pool instance with pg-boss (higher risk; defer)
- Changing intake transaction boundaries / supersede semantics
- LLM/GitHub latency (external)

## Implementation batches

### Batch A — Split web/worker module graphs (startup)

**Hypothesis:** Removing the static `runtime → worker` edge cuts web cold import of ~orchestrator/Pi/executors (~hundreds of ms + RSS).

**Changes:**
1. Split `src/agentWork/runtime.ts` so `agentWorkWebLive` does not import `./worker.js`. Move worker-only Layer wiring into `src/agentWork/workerRuntime.ts` (or equivalent) imported only by `src/worker.ts`.
2. In `src/index.ts`, load the worker entry via dynamic `import()` only when `cfg.role === "worker"` (defense in depth).
3. Add a small unit/static test that the web entry module graph does not include `agentWork/executors/` or `review/orchestrator/`.

**Correctness:** Web still builds `AgentWorkScheduler` + pool + migrations + boss; worker still launches consumers. Existing `agentWorkRuntime.test.ts` / boss tests updated for new import paths.

**Measure:** Re-run nub import timing for a web-only entry helper (server layer without worker graph) and count modules in the static graph.

### Batch B — Skip Pi model catalog validation on web (startup)

**Hypothesis:** Web does not execute agent sessions; skipping `ModelRuntime.create` / pi-ai catalog work removes config-time cost and avoids pulling Pi into the web graph when combined with dynamic import.

**Changes:**
1. In `loadConfig()`, when `role === "web"`, keep reading `PI_*` env strings for boot logs, but **do not** call `assertPiModelSelection`. Set `piApi` to a stable unused placeholder (or omit validation-only resolution) documented as worker-validated.
2. Dynamically import `./settings/modelsJson.js` only on the worker validation path so web does not statically depend on `@earendil-works/pi-*`.
3. Update `docs/configuration.md` to state Pi catalog validation runs on `ROLE=worker` (and any combined/dev paths that load worker).

**Correctness:** Worker still fails fast on bad `PI_PROVIDER`/`PI_MODEL`/`models.json`. Web misconfig is caught when the worker boots (same deploy unit in Compose). Tests covering config validation stay worker-scoped or assert web skip.

**Measure:** Time `loadConfig()` for `ROLE=web` vs `ROLE=worker` with a throwaway PEM + env fixture (no network).

### Batch C — Faster migration no-op (boot query time)

**Hypothesis:** One `SELECT version FROM schema_migrations` + Set lookup beats 20 round-trips.

**Changes:**
1. In `applyMigrations`, after ensuring the table exists, load all applied versions once; skip files present in the set; apply remaining in the same per-file transactions as today.
2. Keep advisory lock semantics unchanged.

**Correctness:** Integration test `migrations.integration.test.ts` still applies fresh + concurrent boots; add assertion that second no-op does a single versions query (optional spy) or keep behavioral tests only.

**Measure:** Against local Postgres: time second `runMigrations` call (no-op) before/after.

### Batch D — Cap pg-boss pool size (infra / connection pressure)

**Hypothesis:** Explicit lower `max` on pg-boss reduces connection fan-out without changing queue semantics.

**Changes:**
1. Add constants (e.g. `PG_BOSS_POOL_MAX_WEB`, `PG_BOSS_POOL_MAX_WORKER` or single `PG_BOSS_POOL_MAX`) in `src/settings/timeoutConstants.ts`.
2. Pass `max` in `bossConstructorOptions`.
3. Document in `docs/configuration.md`; extend `agentWorkBoss.test.ts`.

**Correctness:** Queues still create/start; no change to job payloads. Defaults chosen conservatively (web lower than worker; both ≤ current implicit 10).

**Measure:** Not a latency win primarily — report connection budget (app max + boss max) before/after. Optional: pool total under compose web+worker.

### Batch E — Concurrent symbol index reads (worker setup)

**Hypothesis:** Bounded parallel `readFile` improves wall time on multi-file trees without changing indexed symbols.

**Changes:**
1. In `buildSymbolIndex`, process paths with a concurrency limit (constant, e.g. 8), preserving deterministic insertion order for equal names (process completion order must not change which symbols win the max-symbols cap — process paths in original order, only overlapping I/O).
2. Prefer: read next N files concurrently, then index results in original path order (keeps symbol-cap semantics identical).
3. Extend `test/symbolIndex.test.ts` with order/cap determinism + a timing-friendly multi-file case.

**Measure:** Synthetic temp tree of 1000 small `.ts` files; median of 5 builds.

### Batch F — Code-index FTS single tsquery (query time)

**Hypothesis:** Computing `plainto_tsquery` once per statement reduces CPU on larger chunk tables.

**Changes:**
1. Rewrite `searchCodeIndexFts` SQL to bind/query once (CTE or `CROSS JOIN LATERAL` / subquery).
2. Keep `limit * 4` overfetch + path filter behavior.

**Measure:** Unit-level SQL shape test; optional integration timing if DB up.

### Batch G — Benchmark harness + report

**Changes:**
1. Add `scripts/bench-performance.mjs` (or `.ts` via nub) that prints JSON for: dependency imports, static graph sizes, web vs worker entry imports, symbol-index synthetic tree, migration no-op (if `DATABASE_URL` set).
2. Save baseline and optimized JSON under `/tmp/perf-bench/` during the run; summarize in the PR body with % reduction formula `(baseline - optimized) / baseline * 100`.

## Verification checklist

- [ ] `nub run test` green
- [ ] `nub run typecheck` / lint on touched files
- [ ] Integration migrations + intake when Postgres available
- [ ] Web static graph excludes executors/orchestrator
- [ ] Benchmark table in PR with paired measurements
- [ ] Same-PR doc updates for any new constants / validation behavior (`docs/configuration.md`)

## Stop conditions

Stop after batches A–G if targets met or further gains require Docker image split / intake redesign. Do not chase micro-opts without paired measurements.

## Rollback

Each batch is independently revertable. Prefer small commits per batch when shipping.
