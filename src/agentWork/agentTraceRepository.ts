import type { Pool } from "pg";
import { inTransaction } from "../db/postgres.js";
import type { TraceSpan } from "../traces/traceTypes.js";

export async function appendTraceSpans(pool: Pool, spans: readonly TraceSpan[]): Promise<void> {
  if (spans.length === 0) return;
  await inTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO agent_trace_spans
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(
         id uuid, execution_id uuid, parent_id uuid, work_item_id uuid, kind text,
         role text, phase text, provider text, model text, specialist text,
         started_at timestamptz, ended_at timestamptz, ttft_ms double precision,
         reasoning_ms double precision, input bigint, output bigint,
         cache_read bigint, cache_write bigint, reasoning bigint,
         cost_usd double precision, cost_source text, status text, error_code text, attrs jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        JSON.stringify(
          spans.map((span) => ({
            id: span.id,
            execution_id: span.executionId,
            parent_id: span.parentId,
            work_item_id: span.workItemId,
            kind: span.kind,
            role: span.role,
            phase: span.phase,
            provider: span.provider,
            model: span.model,
            specialist: span.specialist,
            started_at: span.startedAt,
            ended_at: span.endedAt,
            ttft_ms: span.ttftMs,
            reasoning_ms: span.reasoningMs,
            input: span.input,
            output: span.output,
            cache_read: span.cacheRead,
            cache_write: span.cacheWrite,
            reasoning: span.reasoning,
            cost_usd: span.costUsd,
            cost_source: span.costSource,
            status: span.status,
            error_code: span.errorCode,
            attrs: span.attrs,
          })),
        ),
      ],
    );
    const blobs = new Map(spans.flatMap((span) => span.parts.map((part) => [part.sha256, part])));
    if (blobs.size === 0) return;
    await client.query(
      `INSERT INTO agent_trace_blobs (sha256, body, bytes)
       SELECT sha256, body, bytes FROM jsonb_to_recordset($1::jsonb)
         AS b(sha256 text, body text, bytes int)
       ORDER BY sha256
       ON CONFLICT (sha256) DO UPDATE SET last_seen_at = now()`,
      [JSON.stringify([...blobs.values()])],
    );
    await client.query(
      `INSERT INTO agent_trace_parts (span_id, seq, part_kind, blob_sha, redactions)
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS p(span_id uuid, seq int, part_kind text, blob_sha text, redactions int)
       ON CONFLICT (span_id, seq) DO NOTHING`,
      [
        JSON.stringify(
          spans.flatMap((span) =>
            span.parts.map((part, seq) => ({
              span_id: span.id,
              seq,
              part_kind: part.kind,
              blob_sha: part.sha256,
              redactions: part.redactions,
            })),
          ),
        ),
      ],
    );
  });
}

export async function deleteExpiredTraces(
  pool: Pool,
  retentionSeconds: number,
  batchSize: number,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM agent_trace_spans WHERE id IN (
         SELECT id FROM agent_trace_spans
         WHERE started_at < now() - ($1::bigint * interval '1 second') LIMIT $2::int
       )`,
      [retentionSeconds, batchSize],
    );
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batchSize) break;
  }
  // Parts cascade with spans, including work-item cascades. Only unreferenced
  // blobs expire; a repeated prompt may still belong to a younger execution.
  for (;;) {
    const result = await pool.query(
      `DELETE FROM agent_trace_blobs WHERE sha256 IN (
         SELECT sha256 FROM agent_trace_blobs b
         WHERE last_seen_at < now() - ($1::bigint * interval '1 second')
           AND NOT EXISTS (SELECT 1 FROM agent_trace_parts p WHERE p.blob_sha = b.sha256)
         LIMIT $2::int
         FOR UPDATE OF b SKIP LOCKED
       )`,
      [retentionSeconds, batchSize],
    );
    if ((result.rowCount ?? 0) < batchSize) break;
  }
  return deleted;
}
