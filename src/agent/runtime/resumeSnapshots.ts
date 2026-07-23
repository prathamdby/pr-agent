import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { AppError } from "../../errors/appError.js";
import type { AgentSessionRole, ModelAssignment } from "./types.js";

export const RESUME_SNAPSHOT_ENVELOPE_VERSION = 1;
export const DEFAULT_RESUME_SNAPSHOT_MARGIN_SECONDS = 600;

export type ResumeSnapshotPlaintext = {
  readonly conversation: unknown;
  readonly structuredState: unknown;
};

export type ResumeSnapshotEnvelopeMeta = {
  readonly envelopeVersion: number;
  readonly installationId: number;
  readonly workItemId: string;
  readonly sessionRole: AgentSessionRole;
  readonly model: ModelAssignment;
  readonly sdkVersion: string;
  readonly promptVersion: string;
  readonly toolPolicyVersion: string;
  readonly checkpointId: string;
  readonly expiresAt: Date;
};

export type EncryptedResumeSnapshot = ResumeSnapshotEnvelopeMeta & {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
};

function decodeMasterKey(keyMaterial: string): Buffer {
  const trimmed = keyMaterial.trim();
  if (!trimmed) {
    throw new AppError({
      code: "runtime.resume_snapshot_key_missing",
      message: "AGENT_RESUME_SNAPSHOT_KEY is required to encrypt resume snapshots",
    });
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new AppError({
      code: "runtime.resume_snapshot_key_invalid",
      message: "AGENT_RESUME_SNAPSHOT_KEY must be base64-encoded 32-byte key material",
      context: { byteLength: key.length },
    });
  }
  return key;
}

function tenantKey(masterKey: Buffer, installationId: number): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.alloc(0), `pr-agent:resume:${installationId}`, 32),
  );
}

export function computeResumeSnapshotTtlSeconds(params: {
  readonly queueRetryLimit: number;
  readonly queueRetryDelayMaxSeconds: number;
  readonly marginSeconds?: number;
}): number {
  const margin = params.marginSeconds ?? DEFAULT_RESUME_SNAPSHOT_MARGIN_SECONDS;
  const retryWindow =
    Math.max(0, params.queueRetryLimit) * Math.max(0, params.queueRetryDelayMaxSeconds);
  return retryWindow + margin;
}

export function encryptResumeSnapshot(params: {
  readonly keyMaterial: string;
  readonly meta: ResumeSnapshotEnvelopeMeta;
  readonly plaintext: ResumeSnapshotPlaintext;
}): EncryptedResumeSnapshot {
  if (params.meta.envelopeVersion !== RESUME_SNAPSHOT_ENVELOPE_VERSION) {
    throw new AppError({
      code: "runtime.resume_snapshot_version_unsupported",
      message: "Unsupported resume snapshot envelope version",
      context: { envelopeVersion: params.meta.envelopeVersion },
    });
  }
  const master = decodeMasterKey(params.keyMaterial);
  const key = tenantKey(master, params.meta.installationId);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const aad = Buffer.from(
    JSON.stringify({
      installationId: params.meta.installationId,
      workItemId: params.meta.workItemId,
      sessionRole: params.meta.sessionRole,
      checkpointId: params.meta.checkpointId,
      envelopeVersion: params.meta.envelopeVersion,
    }),
  );
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(params.plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ...params.meta,
    nonce,
    ciphertext,
    authTag,
  };
}

export function decryptResumeSnapshot(params: {
  readonly keyMaterial: string;
  readonly envelope: EncryptedResumeSnapshot;
  readonly now?: Date;
}): ResumeSnapshotPlaintext {
  const now = params.now ?? new Date();
  if (params.envelope.envelopeVersion !== RESUME_SNAPSHOT_ENVELOPE_VERSION) {
    throw new AppError({
      code: "runtime.resume_snapshot_version_mismatch",
      message: "Resume snapshot envelope version mismatch",
      context: { envelopeVersion: params.envelope.envelopeVersion },
    });
  }
  if (params.envelope.expiresAt.getTime() <= now.getTime()) {
    throw new AppError({
      code: "runtime.resume_snapshot_expired",
      message: "Resume snapshot expired",
      context: {
        workItemId: params.envelope.workItemId,
        sessionRole: params.envelope.sessionRole,
      },
    });
  }
  const master = decodeMasterKey(params.keyMaterial);
  const key = tenantKey(master, params.envelope.installationId);
  const decipher = createDecipheriv("aes-256-gcm", key, params.envelope.nonce);
  const aad = Buffer.from(
    JSON.stringify({
      installationId: params.envelope.installationId,
      workItemId: params.envelope.workItemId,
      sessionRole: params.envelope.sessionRole,
      checkpointId: params.envelope.checkpointId,
      envelopeVersion: params.envelope.envelopeVersion,
    }),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(params.envelope.authTag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(params.envelope.ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as ResumeSnapshotPlaintext;
  } catch (error) {
    throw new AppError({
      code: "runtime.resume_snapshot_auth_failed",
      message: "Resume snapshot authentication failed",
      cause: error instanceof Error ? error : undefined,
      context: {
        workItemId: params.envelope.workItemId,
        sessionRole: params.envelope.sessionRole,
      },
    });
  }
}
