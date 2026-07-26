import type { Pool, PoolClient } from "pg";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import {
  getAgentPhaseCheckpoint,
  upsertAgentPhaseCheckpoint,
} from "../../agentWork/phaseCheckpointRepository.js";
import {
  deleteResumeSnapshotsForWorkItem,
  loadResumeSnapshot,
  upsertResumeSnapshot,
} from "../../agentWork/resumeSnapshotRepository.js";
import {
  computeResumeSnapshotTtlSeconds,
  type ResumeSnapshotPlaintext,
} from "./resumeSnapshots.js";
import type {
  AgentSessionPhase,
  AgentSessionRole,
  AuthoritativeStructuredState,
} from "./types.js";
import { EMPTY_STRUCTURED_STATE } from "./types.js";

export const RESUME_SNAPSHOT_SDK_VERSION = "pi-session-1";
export const RESUME_SNAPSHOT_PROMPT_VERSION = "prompt-1";
export const RESUME_SNAPSHOT_TOOL_POLICY_VERSION = "tools-1";

export type FeatureSessionDurability = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly installationId: number;
};

const PHASE_ORDINAL: Readonly<Record<AgentSessionPhase, number>> = {
  recon: 10,
  specialist: 20,
  judgment: 30,
  synthesis: 40,
  validation_repair: 50,
  publish_recovery: 60,
  ask: 10,
  description: 10,
  triage: 10,
  verification: 10,
  ci_summary: 10,
};

export function phaseOrdinal(phase: string): number {
  if (Object.prototype.hasOwnProperty.call(PHASE_ORDINAL, phase)) {
    return PHASE_ORDINAL[phase as AgentSessionPhase];
  }
  return -1;
}

function isAuthoritativeStructuredState(value: unknown): value is AuthoritativeStructuredState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === "number" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    !Array.isArray(candidate.payload)
  );
}

function snapshotConversationPhase(conversation: unknown): string | undefined {
  if (typeof conversation !== "object" || conversation === null) return undefined;
  const lastPhase = (conversation as Record<string, unknown>).lastPhase;
  return typeof lastPhase === "string" ? lastPhase : undefined;
}

/** True when the durable checkpoint should supply structured state over the snapshot. */
export function checkpointOutranksSnapshot(params: {
  readonly checkpointPhase: string;
  readonly checkpointVersion: number;
  readonly checkpointUpdatedAt: Date;
  readonly snapshotPhase?: string;
  readonly snapshotVersion: number;
  readonly snapshotUpdatedAt: Date;
}): boolean {
  const checkpointPhaseOrd = phaseOrdinal(params.checkpointPhase);
  const snapshotPhaseOrd = phaseOrdinal(params.snapshotPhase ?? "");
  if (checkpointPhaseOrd !== snapshotPhaseOrd) {
    return checkpointPhaseOrd >= snapshotPhaseOrd;
  }
  if (params.checkpointVersion !== params.snapshotVersion) {
    return params.checkpointVersion >= params.snapshotVersion;
  }
  return params.checkpointUpdatedAt.getTime() >= params.snapshotUpdatedAt.getTime();
}

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
    queueExpireInSeconds: cfg.queueExpireInSeconds,
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
  | {
      readonly ok: true;
      readonly plaintext: ResumeSnapshotPlaintext;
      readonly checkpointId: string;
      readonly updatedAt: Date;
    }
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

/**
 * Resolve session structured state for recovery.
 * Phase checkpoints are authoritative; resume snapshots supply conversation bytes only
 * when a newer-or-equal checkpoint is present.
 */
export async function resolveDurableStructuredState(params: {
  readonly role: AgentSessionRole;
  readonly cfg: Config;
  readonly structuredState?: AuthoritativeStructuredState;
  readonly durability: FeatureSessionDurability;
}): Promise<AuthoritativeStructuredState> {
  const checkpoint = await getAgentPhaseCheckpoint(
    params.durability.pool,
    params.durability.workItemId,
    params.role,
  );
  const snapshot = await loadResumeSnapshotIfConfigured(params.durability.pool, params.cfg, {
    workItemId: params.durability.workItemId,
    sessionRole: params.role,
    expectedInstallationId: params.durability.installationId,
  });

  const checkpointState =
    checkpoint && isAuthoritativeStructuredState(checkpoint.structuredState)
      ? checkpoint.structuredState
      : null;
  const snapshotState =
    snapshot.ok && isAuthoritativeStructuredState(snapshot.plaintext.structuredState)
      ? snapshot.plaintext.structuredState
      : null;

  let chosen: AuthoritativeStructuredState | null = null;
  let resumeCheckpointId: string | undefined;
  let lastCompletedPhase: string | undefined;
  let resumeConversation: unknown;

  if (checkpointState && checkpoint) {
    chosen = checkpointState;
    resumeCheckpointId = checkpoint.checkpointId;
    lastCompletedPhase = checkpoint.phase;
    if (snapshotState && snapshot.ok) {
      const attachConversation = checkpointOutranksSnapshot({
        checkpointPhase: checkpoint.phase,
        checkpointVersion: checkpointState.version,
        checkpointUpdatedAt: checkpoint.updatedAt,
        snapshotPhase: snapshotConversationPhase(snapshot.plaintext.conversation),
        snapshotVersion: snapshotState.version,
        snapshotUpdatedAt: snapshot.updatedAt,
      });
      if (attachConversation) {
        resumeConversation = snapshot.plaintext.conversation;
      }
    }
  } else if (snapshotState && snapshot.ok) {
    chosen = snapshotState;
    resumeCheckpointId = snapshot.checkpointId;
    lastCompletedPhase = snapshotConversationPhase(snapshot.plaintext.conversation);
    resumeConversation = snapshot.plaintext.conversation;
  }

  if (!chosen) {
    return params.structuredState ?? EMPTY_STRUCTURED_STATE;
  }

  return {
    version: chosen.version,
    payload: {
      ...chosen.payload,
      ...(resumeCheckpointId ? { __resumeCheckpointId: resumeCheckpointId } : {}),
      ...(lastCompletedPhase ? { __lastCompletedPhase: lastCompletedPhase } : {}),
      ...(resumeConversation !== undefined
        ? { __resumeConversation: resumeConversation }
        : {}),
    },
  };
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
