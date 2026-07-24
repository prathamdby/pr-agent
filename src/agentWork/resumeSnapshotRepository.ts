import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AgentSessionRole } from "../agent/runtime/types.js";
import {
  decryptResumeSnapshot,
  encryptResumeSnapshot,
  type EncryptedResumeSnapshot,
  type ResumeSnapshotPlaintext,
  RESUME_SNAPSHOT_ENVELOPE_VERSION,
} from "../agent/runtime/resumeSnapshots.js";
import { queryOne } from "../db/postgres.js";

export async function upsertResumeSnapshot(
  client: Pool | PoolClient,
  params: {
    readonly keyMaterial: string;
    readonly workItemId: string;
    readonly sessionRole: AgentSessionRole;
    readonly installationId: number;
    readonly modelProvider: string;
    readonly modelId: string;
    readonly sdkVersion: string;
    readonly promptVersion: string;
    readonly toolPolicyVersion: string;
    readonly checkpointId: string;
    readonly expiresAt: Date;
    readonly plaintext: ResumeSnapshotPlaintext;
  },
): Promise<void> {
  const encrypted = encryptResumeSnapshot({
    keyMaterial: params.keyMaterial,
    meta: {
      envelopeVersion: RESUME_SNAPSHOT_ENVELOPE_VERSION,
      installationId: params.installationId,
      workItemId: params.workItemId,
      sessionRole: params.sessionRole,
      model: { provider: params.modelProvider, model: params.modelId },
      sdkVersion: params.sdkVersion,
      promptVersion: params.promptVersion,
      toolPolicyVersion: params.toolPolicyVersion,
      checkpointId: params.checkpointId,
      expiresAt: params.expiresAt,
    },
    plaintext: params.plaintext,
  });
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO agent_resume_snapshots (
       id, work_item_id, session_role, installation_id, envelope_version,
       model_provider, model_id, sdk_version, prompt_version, tool_policy_version,
       checkpoint_id, expires_at, nonce, ciphertext, auth_tag
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
     )
     ON CONFLICT (work_item_id, session_role) DO UPDATE SET
       installation_id = EXCLUDED.installation_id,
       envelope_version = EXCLUDED.envelope_version,
       model_provider = EXCLUDED.model_provider,
       model_id = EXCLUDED.model_id,
       sdk_version = EXCLUDED.sdk_version,
       prompt_version = EXCLUDED.prompt_version,
       tool_policy_version = EXCLUDED.tool_policy_version,
       checkpoint_id = EXCLUDED.checkpoint_id,
       expires_at = EXCLUDED.expires_at,
       nonce = EXCLUDED.nonce,
       ciphertext = EXCLUDED.ciphertext,
       auth_tag = EXCLUDED.auth_tag,
       updated_at = now()`,
    [
      id,
      encrypted.workItemId,
      encrypted.sessionRole,
      encrypted.installationId,
      encrypted.envelopeVersion,
      encrypted.model.provider,
      encrypted.model.model,
      encrypted.sdkVersion,
      encrypted.promptVersion,
      encrypted.toolPolicyVersion,
      encrypted.checkpointId,
      encrypted.expiresAt.toISOString(),
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.authTag,
    ],
  );
}

export async function loadResumeSnapshot(
  client: Pool | PoolClient,
  params: {
    readonly keyMaterial: string;
    readonly workItemId: string;
    readonly sessionRole: AgentSessionRole;
    readonly expectedInstallationId: number;
    readonly now?: Date;
  },
): Promise<
  | {
      readonly ok: true;
      readonly plaintext: ResumeSnapshotPlaintext;
      readonly checkpointId: string;
    }
  | { readonly ok: false; readonly reason: string }
> {
  const row = await queryOne<{
    installation_id: string;
    envelope_version: number;
    model_provider: string;
    model_id: string;
    sdk_version: string;
    prompt_version: string;
    tool_policy_version: string;
    checkpoint_id: string;
    expires_at: Date;
    nonce: Buffer;
    ciphertext: Buffer;
    auth_tag: Buffer;
  }>(
    client,
    `SELECT installation_id, envelope_version, model_provider, model_id, sdk_version,
            prompt_version, tool_policy_version, checkpoint_id, expires_at, nonce, ciphertext, auth_tag
       FROM agent_resume_snapshots
      WHERE work_item_id = $1 AND session_role = $2
      LIMIT 1`,
    [params.workItemId, params.sessionRole],
  );
  if (!row) return { ok: false, reason: "missing" };
  const installationId = Number(row.installation_id);
  if (installationId !== params.expectedInstallationId) {
    await deleteResumeSnapshot(client, params.workItemId, params.sessionRole);
    return { ok: false, reason: "tenant_mismatch" };
  }
  const envelope: EncryptedResumeSnapshot = {
    envelopeVersion: row.envelope_version,
    installationId,
    workItemId: params.workItemId,
    sessionRole: params.sessionRole,
    model: { provider: row.model_provider, model: row.model_id },
    sdkVersion: row.sdk_version,
    promptVersion: row.prompt_version,
    toolPolicyVersion: row.tool_policy_version,
    checkpointId: row.checkpoint_id,
    expiresAt: new Date(row.expires_at),
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.auth_tag,
  };
  try {
    const plaintext = decryptResumeSnapshot({
      keyMaterial: params.keyMaterial,
      envelope,
      now: params.now,
    });
    return { ok: true, plaintext, checkpointId: envelope.checkpointId };
  } catch {
    await deleteResumeSnapshot(client, params.workItemId, params.sessionRole);
    return { ok: false, reason: "invalid" };
  }
}

export async function deleteResumeSnapshot(
  client: Pool | PoolClient,
  workItemId: string,
  sessionRole: AgentSessionRole,
): Promise<void> {
  await client.query(
    `DELETE FROM agent_resume_snapshots WHERE work_item_id = $1 AND session_role = $2`,
    [workItemId, sessionRole],
  );
}

export async function deleteResumeSnapshotsForWorkItem(
  client: Pool | PoolClient,
  workItemId: string,
): Promise<void> {
  await client.query(`DELETE FROM agent_resume_snapshots WHERE work_item_id = $1`, [workItemId]);
}

export async function deleteExpiredResumeSnapshots(
  client: Pool | PoolClient,
  now: Date = new Date(),
): Promise<number> {
  const result = await client.query(`DELETE FROM agent_resume_snapshots WHERE expires_at <= $1`, [
    now.toISOString(),
  ]);
  return result.rowCount ?? 0;
}
