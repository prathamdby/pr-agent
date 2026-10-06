import { ENV } from "../src/settings/index.js";
import { requireEnv } from "../src/settings/envReaders.js";
import { createPgPool } from "../src/db/postgres.js";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { execution: { type: "string" }, signals: { type: "boolean" } },
});
if (values.execution && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values.execution)) {
  throw new Error("--execution must be a UUID");
}
const pool = createPgPool(
  {
    runtime: { role: "worker", port: 0, databaseUrl: requireEnv(ENV.DATABASE_URL) },
  },
  2,
);

try {
  const report = await pool.query(
    `WITH spans AS (
       SELECT *, extract(epoch FROM ended_at - started_at) * 1000 AS latency_ms
       FROM agent_trace_spans WHERE ($1::uuid IS NULL OR execution_id = $1)
     ), generations AS (
       SELECT provider, model, role, phase, specialist,
         count(*) AS generations,
         count(*) FILTER (WHERE status <> 'ok') AS errors,
         count(*) FILTER (WHERE attrs->>'retry_folded' = 'true') AS retry_folded,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) AS observed_ttft_p50_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) AS observed_ttft_p95_ms,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS observed_latency_p50_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS observed_latency_p95_ms,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
           FILTER (WHERE attrs->>'retry_folded' = 'false' AND status = 'ok') AS model_latency_p50_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
           FILTER (WHERE attrs->>'retry_folded' = 'false' AND status = 'ok') AS model_latency_p95_ms,
         sum(input) AS input, sum(output) AS output,
         sum(cache_read) AS cache_read, sum(cache_write) AS cache_write,
         sum(reasoning) AS reasoning,
         sum(cache_read)::double precision / NULLIF(sum(input + cache_read + cache_write), 0) AS cache_hit_rate,
         count(cost_usd) AS known_cost_generations,
         sum(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS known_cost_usd
       FROM spans WHERE kind = 'generation'
       GROUP BY provider, model, role, phase, specialist
     ), tools AS (
       SELECT provider, model, role, phase, specialist, count(*) AS tool_calls,
         count(*) FILTER (WHERE status <> 'ok')::double precision / NULLIF(count(*), 0) AS tool_error_rate
       FROM spans WHERE kind = 'tool' GROUP BY provider, model, role, phase, specialist
     )
     SELECT g.*, t.tool_calls, t.tool_error_rate
     FROM generations g LEFT JOIN tools t
       ON g.provider IS NOT DISTINCT FROM t.provider AND g.model IS NOT DISTINCT FROM t.model
       AND g.role IS NOT DISTINCT FROM t.role AND g.phase IS NOT DISTINCT FROM t.phase
       AND g.specialist IS NOT DISTINCT FROM t.specialist
     ORDER BY g.provider, g.model, g.role, g.phase, g.specialist`,
    [values.execution ?? null],
  );
  const costs = await pool.query(
    `SELECT provider, model, count(*) AS known_generations,
       sum(cost_usd) AS cost_usd, avg(cost_usd) AS mean_generation_cost_usd
     FROM agent_trace_spans WHERE kind = 'generation' AND cost_usd IS NOT NULL
       AND ($1::uuid IS NULL OR execution_id = $1)
     GROUP BY provider, model ORDER BY mean_generation_cost_usd`,
    [values.execution ?? null],
  );
  const signals = values.signals
    ? await pool.query(
        `WITH spans AS (
       SELECT * FROM agent_trace_spans WHERE ($1::uuid IS NULL OR execution_id = $1)
     ), repeated AS (
       SELECT execution_id, provider, model, role, specialist,
         attrs->>'call_fingerprint' AS fingerprint, count(*) AS calls
       FROM spans WHERE kind = 'tool' AND attrs ? 'call_fingerprint'
       GROUP BY execution_id, provider, model, role, specialist, attrs->>'call_fingerprint'
       HAVING count(*) > 1
     ), signals AS (
       SELECT provider, model, role, phase, specialist, signal, amount
       FROM spans CROSS JOIN LATERAL (VALUES
         ('compaction', kind = 'compaction', 1),
         ('few_tools_no_findings', kind = 'session' AND role = 'specialist'
           AND attrs->>'findings_count' = '0'
           AND COALESCE((attrs->>'tools')::int, 0) + COALESCE((attrs->>'completed_host_calls')::int, 0) <= 2, 1),
         ('schema_validation_rejection', kind = 'tool' AND attrs->>'validation_rejected' = 'true', 1),
         ('code_mode_budget_hit', kind = 'tool' AND attrs->>'code_mode_budget_hit' = 'true', 1),
         ('schema_validation_retry', kind = 'session', COALESCE((attrs->>'schema_validation_retries')::int, 0)),
         ('tool_round_budget_hit', kind = 'session', COALESCE((attrs->>'tool_round_budget_hits')::int, 0)),
         ('empty_final_text', kind = 'generation' AND status = 'ok' AND attrs->>'empty_final_text' = 'true', 1)
       ) AS flags(signal, enabled, amount) WHERE enabled AND amount > 0
       UNION ALL
       SELECT provider, model, role, NULL, specialist,
         'repeated_identical_tool_call', (calls - 1)::int FROM repeated
     )
     SELECT provider, model, role, phase, specialist, signal, sum(amount) AS occurrences
     FROM signals GROUP BY provider, model, role, phase, specialist, signal
     ORDER BY provider, model, role, phase, specialist, signal`,
        [values.execution ?? null],
      )
    : undefined;
  console.log(
    JSON.stringify(
      {
        execution: values.execution ?? null,
        latency_note:
          "Observed timing includes folded provider-client retries. Only unfolded successful generations enter model latency. Unknown cost is excluded from cost rankings.",
        generations: report.rows,
        cost_rankings: costs.rows,
        ...(signals ? { signals: signals.rows } : {}),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
