import crypto from "node:crypto";
import type { IntakeClient } from "../db/postgres.js";
import type { AgentSessionRole, AuthoritativeStructuredState } from "../agent/runtime/types.js";
import { AppError } from "../errors/appError.js";
import { queryOne } from "../db/postgres.js";

export type AgentPhaseCheckpointRow = {
  readonly id: string;
  readonly workItemId: string;
  readonly sessionRole: AgentSessionRole;
  readonly checkpointId: string;
  readonly phase: string;
  readonly structuredState: AuthoritativeStructuredState;
  readonly version: number;
  readonly updatedAt: Date;
};

export async function upsertAgentPhaseCheckpoint(
  client: IntakeClient,
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
    updated_at: Date;
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
     RETURNING id, work_item_id, session_role, checkpoint_id, phase, structured_state, version, updated_at`,
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
    throw new AppError({
      code: "agent_phase_checkpoint.upsert_no_row",
      message: "upsertAgentPhaseCheckpoint returned no row",
      context: {
        workItemId: params.workItemId,
        sessionRole: params.sessionRole,
      },
    });
  }
  return {
    id: row.id,
    workItemId: row.work_item_id,
    sessionRole: row.session_role,
    checkpointId: row.checkpoint_id,
    phase: row.phase,
    structuredState: row.structured_state,
    version: row.version,
    updatedAt: new Date(row.updated_at),
  };
}

export async function getAgentPhaseCheckpoint(
  client: IntakeClient,
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
    updated_at: Date;
  }>(
    client,
    `SELECT id, work_item_id, session_role, checkpoint_id, phase, structured_state, version, updated_at
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
    updatedAt: new Date(row.updated_at),
  };
}
