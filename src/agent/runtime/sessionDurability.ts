import type { Pool, PoolClient } from "pg";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { upsertAgentPhaseCheckpoint } from "../../agentWork/phaseCheckpointRepository.js";
import {
  deleteResumeSnapshotsForWorkItem,
  loadResumeSnapshot,
  upsertResumeSnapshot,
} from "../../agentWork/resumeSnapshotRepository.js";
import {
  computeResumeSnapshotTtlSeconds,
  type ResumeSnapshotPlaintext,
} from "./resumeSnapshots.js";
import type { AgentSessionRole, AuthoritativeStructuredState } from "./types.js";

export const RESUME_SNAPSHOT_SDK_VERSION = "pi-session-1";
export const RESUME_SNAPSHOT_PROMPT_VERSION = "prompt-1";
export const RESUME_SNAPSHOT_TOOL_POLICY_VERSION = "tools-1";

export type FeatureSessionDurability = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly installationId: number;
};

export async function commitPhaseCheckpoint(
  pool: Pool | PoolClient,
  params: {
    readonly workItemId: string;
    readonly sessionRole: AgentSessionRole;
    readonly checkpointId: string;
    readonly phase: string;
    readonly structuredState: AuthoritativeStructuredState;
  },
): Promise<void> {
  await upsertAgentPhaseCheckpoint(pool, params);
}

export async function saveResumeSnapshotIfConfigured(
  pool: Pool | PoolClient,
  cfg: Config,
  params: {
    readonly workItemId: string;
    readonly sessionRole: AgentSessionRole;
    readonly installationId: number;
    readonly modelProvider: string;
    readonly modelId: string;
    readonly checkpointId: string;
    readonly plaintext: ResumeSnapshotPlaintext;
  },
): Promise<void> {
  if (!cfg.agentResumeSnapshotKey.trim()) return;

  const ttlSeconds = computeResumeSnapshotTtlSeconds({
    queueRetryLimit: cfg.queueRetryLimit,
    queueRetryDelayMaxSeconds: cfg.queueRetryDelayMaxSeconds,
    marginSeconds: cfg.agentResumeSnapshotMarginSeconds,
  });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await upsertResumeSnapshot(pool, {
    keyMaterial: cfg.agentResumeSnapshotKey,
    workItemId: params.workItemId,
    sessionRole: params.sessionRole,
    installationId: params.installationId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    sdkVersion: RESUME_SNAPSHOT_SDK_VERSION,
    promptVersion: RESUME_SNAPSHOT_PROMPT_VERSION,
    toolPolicyVersion: RESUME_SNAPSHOT_TOOL_POLICY_VERSION,
    checkpointId: params.checkpointId,
    expiresAt,
    plaintext: params.plaintext,
  });
}

export type LoadedResumeSnapshot =
  | { readonly ok: true; readonly plaintext: ResumeSnapshotPlaintext; readonly checkpointId: string }
  | { readonly ok: false; readonly reason: string };

export async function loadResumeSnapshotIfConfigured(
  pool: Pool | PoolClient,
  cfg: Config,
  params: {
    readonly workItemId: string;
    readonly sessionRole: AgentSessionRole;
    readonly expectedInstallationId: number;
  },
): Promise<LoadedResumeSnapshot | { readonly ok: false; readonly reason: "disabled" }> {
  if (!cfg.agentResumeSnapshotKey.trim()) {
    return { ok: false, reason: "disabled" };
  }
  return loadResumeSnapshot(pool, {
    keyMaterial: cfg.agentResumeSnapshotKey,
    workItemId: params.workItemId,
    sessionRole: params.sessionRole,
    expectedInstallationId: params.expectedInstallationId,
  });
}

export async function clearResumeSnapshots(
  pool: Pool | PoolClient,
  workItemId: string,
): Promise<void> {
  await deleteResumeSnapshotsForWorkItem(pool, workItemId);
}

export async function clearResumeSnapshotsBestEffort(
  pool: Pool | PoolClient,
  workItemId: string,
): Promise<void> {
  try {
    await clearResumeSnapshots(pool, workItemId);
  } catch (error) {
    logWarn("resume_snapshots_clear_failed", {
      workItemId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
