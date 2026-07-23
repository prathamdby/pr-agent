import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AgentSessionRole, AuthoritativeStructuredState } from "../agent/runtime/types.js";
import { queryOne } from "../db/postgres.js";

export type AgentPhaseCheckpointRow = {
  readonly id: string;
  readonly workItemId: string;
  readonly sessionRole: AgentSessionRole;
  readonly checkpointId: string;
  readonly phase: string;
  readonly structuredState: AuthoritativeStructuredState;
  readonly version: number;
};

export async function upsertAgentPhaseCheckpoint(
  client: Pool | PoolClient,
  params: {
    readonly workItemId: string;
    readonly sessionRole: AgentSessionRole;
    readonly checkpointId: string;
    readonly phase: string;
    readonly structuredState: AuthoritativeStructuredState;
  },
): Promise<AgentPhaseCheckpointRow> {
  const id = crypto.randomUUID();
  const row = await queryOne<{
    id: string;
    work_item_id: string;
    session_role: AgentSessionRole;
    checkpoint_id: string;
    phase: string;
    structured_state: AuthoritativeStructuredState;
    version: number;
  }>(
    client,
    `INSERT INTO agent_phase_checkpoints (
       id, work_item_id, session_role, checkpoint_id, phase, structured_state, version
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (work_item_id, session_role) DO UPDATE SET
       checkpoint_id = EXCLUDED.checkpoint_id,
       phase = EXCLUDED.phase,
       structured_state = EXCLUDED.structured_state,
       version = EXCLUDED.version,
       updated_at = now()
     RETURNING id, work_item_id, session_role, checkpoint_id, phase, structured_state, version`,
    [
      id,
      params.workItemId,
      params.sessionRole,
      params.checkpointId,
      params.phase,
      JSON.stringify(params.structuredState),
      params.structuredState.version,
    ],
  );
  if (!row) {
    throw new Error("upsertAgentPhaseCheckpoint returned no row");
  }
  return {
    id: row.id,
    workItemId: row.work_item_id,
    sessionRole: row.session_role,
    checkpointId: row.checkpoint_id,
    phase: row.phase,
    structuredState: row.structured_state,
    version: row.version,
  };
}

export async function getAgentPhaseCheckpoint(
  client: Pool | PoolClient,
  workItemId: string,
  sessionRole: AgentSessionRole,
): Promise<AgentPhaseCheckpointRow | null> {
  const row = await queryOne<{
    id: string;
    work_item_id: string;
    session_role: AgentSessionRole;
    checkpoint_id: string;
    phase: string;
    structured_state: AuthoritativeStructuredState;
    version: number;
  }>(
    client,
    `SELECT id, work_item_id, session_role, checkpoint_id, phase, structured_state, version
       FROM agent_phase_checkpoints
      WHERE work_item_id = $1 AND session_role = $2
      LIMIT 1`,
    [workItemId, sessionRole],
  );
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    sessionRole: row.session_role,
    checkpointId: row.checkpoint_id,
    phase: row.phase,
    structuredState: row.structured_state,
    version: row.version,
  };
}
