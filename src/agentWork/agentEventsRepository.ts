import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { logWarn } from "../evlog.js";

export type AgentEventInsertRow = {
  readonly workItemId?: string | null;
  readonly installationId?: number | null;
  readonly owner?: string | null;
  readonly repo?: string | null;
  readonly prNumber?: number | null;
  readonly sessionRole?: string | null;
  readonly eventKind: string;
  readonly phase?: string | null;
  readonly checkpointId?: string | null;
  readonly toolName?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly ok?: boolean | null;
  readonly failureCode?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type AgentEventRow = {
  readonly id: string;
  readonly workItemId: string | null;
  readonly installationId: number | null;
  readonly owner: string | null;
  readonly repo: string | null;
  readonly prNumber: number | null;
  readonly sessionRole: string | null;
  readonly eventKind: string;
  readonly phase: string | null;
  readonly checkpointId: string | null;
  readonly toolName: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly ok: boolean | null;
  readonly failureCode: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly recordedAt: Date;
};

function mapAgentEventRow(row: {
  id: string;
  work_item_id: string | null;
  installation_id: string | null;
  owner: string | null;
  repo: string | null;
  pr_number: number | null;
  session_role: string | null;
  event_kind: string;
  phase: string | null;
  checkpoint_id: string | null;
  tool_name: string | null;
  provider: string | null;
  model: string | null;
  ok: boolean | null;
  failure_code: string | null;
  detail: Readonly<Record<string, unknown>>;
  recorded_at: Date;
}): AgentEventRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    installationId: row.installation_id == null ? null : Number(row.installation_id),
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    sessionRole: row.session_role,
    eventKind: row.event_kind,
    phase: row.phase,
    checkpointId: row.checkpoint_id,
    toolName: row.tool_name,
    provider: row.provider,
    model: row.model,
    ok: row.ok,
    failureCode: row.failure_code,
    detail: row.detail ?? {},
    recordedAt: new Date(row.recorded_at),
  };
}

export async function appendAgentEvents(
  client: Pool | PoolClient,
  rows: readonly AgentEventInsertRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const base = index * 15;
    values.push(
      row.workItemId ?? null,
      row.installationId ?? null,
      row.owner ?? null,
      row.repo ?? null,
      row.prNumber ?? null,
      row.sessionRole ?? null,
      row.eventKind,
      row.phase ?? null,
      row.checkpointId ?? null,
      row.toolName ?? null,
      row.provider ?? null,
      row.model ?? null,
      row.ok ?? null,
      row.failureCode ?? null,
      JSON.stringify(row.detail ?? {}),
    );
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15}::jsonb)`;
  });

  await client.query(
    `INSERT INTO agent_events (
       work_item_id, installation_id, owner, repo, pr_number,
       session_role, event_kind, phase, checkpoint_id, tool_name,
       provider, model, ok, failure_code, detail
     ) VALUES ${placeholders.join(", ")}`,
    values,
  );
}

/** Fire-and-forget append that never throws into the review hot path. */
export function safeAppendAgentEvents(
  client: Pool | PoolClient,
  cfg: Pick<Config, "agentEventsEnabled">,
  rows: readonly AgentEventInsertRow[],
): void {
  if (!cfg.agentEventsEnabled || rows.length === 0) return;
  void appendAgentEvents(client, rows).catch((error) => {
    logWarn("agent_events_append_failed", {
      count: rows.length,
      eventKinds: rows.map((row) => row.eventKind),
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function listAgentEventsByWorkItem(
  client: Pool | PoolClient,
  workItemId: string,
): Promise<readonly AgentEventRow[]> {
  const result = await client.query<{
    id: string;
    work_item_id: string | null;
    installation_id: string | null;
    owner: string | null;
    repo: string | null;
    pr_number: number | null;
    session_role: string | null;
    event_kind: string;
    phase: string | null;
    checkpoint_id: string | null;
    tool_name: string | null;
    provider: string | null;
    model: string | null;
    ok: boolean | null;
    failure_code: string | null;
    detail: Readonly<Record<string, unknown>>;
    recorded_at: Date;
  }>(
    `SELECT id, work_item_id, installation_id, owner, repo, pr_number,
            session_role, event_kind, phase, checkpoint_id, tool_name,
            provider, model, ok, failure_code, detail, recorded_at
       FROM agent_events
      WHERE work_item_id = $1
      ORDER BY recorded_at ASC`,
    [workItemId],
  );
  return result.rows.map(mapAgentEventRow);
}
