import type { Pool, PoolClient } from "pg";
import type { Config } from "../settings/index.js";
import { logWarn } from "../evlog.js";
import { errorMessage } from "../errors/errorMessage.js";

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

export function safeAppendAgentEvents(
  client: Pool | PoolClient,
  cfg: Pick<Config, "agentEvents">,
  rows: readonly AgentEventInsertRow[],
): void {
  if (!cfg.agentEvents.enabled || rows.length === 0) return;
  void appendAgentEvents(client, rows).catch((error) => {
    logWarn("agent_events_append_failed", {
      count: rows.length,
      eventKinds: rows.map((row) => row.eventKind),
      message: errorMessage(error),
    });
  });
}
