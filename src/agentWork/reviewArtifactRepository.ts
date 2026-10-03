import type { Pool, PoolClient } from "pg";
import { inTransaction, queryOne } from "../db/postgres.js";
import { AppError } from "../errors/appError.js";
import {
  encodeReviewArtifact,
  parseReviewArtifactEnvelope,
  reviewArtifactDependencies,
  reviewArtifactHash,
  reviewArtifactInvalid,
  type ReviewArtifactBinding,
  type ReviewArtifactEnvelope,
} from "../review/recovery/reviewArtifacts.js";
import { lockPrActorLeaseForUpdate } from "./prActorLease.js";

export const REVIEW_ARTIFACT_BUDGET_BYTES = 1_048_576;
export const REVIEW_SETTLEMENT_RESERVE_BYTES = 8_192;

/** Misses disable new caching. Other errors reach the durable retry/stop policy. */
export type ReviewArtifactWriteResult = "stored" | "existing" | "capacity" | "incompatible";

type ArtifactRow = {
  logical_key: string;
  artifact_order: number;
  kind: ReviewArtifactEnvelope["artifact"]["kind"];
  input_fingerprint: string;
  payload_hash: string;
  envelope: string;
  reserved_bytes: number;
};

function decodeArtifact(row: ArtifactRow, binding: ReviewArtifactBinding) {
  let value: unknown;
  try {
    value = JSON.parse(row.envelope);
  } catch {
    return null;
  }
  const envelope = parseReviewArtifactEnvelope(value);
  if (
    !envelope ||
    row.logical_key !== envelope.logicalKey ||
    row.artifact_order !== envelope.order ||
    row.kind !== envelope.artifact.kind ||
    row.input_fingerprint !== binding.inputFingerprint ||
    encodeReviewArtifact(envelope.binding) !== encodeReviewArtifact(binding) ||
    row.payload_hash !== reviewArtifactHash(envelope)
  )
    return null;
  return envelope;
}

async function artifactRow(db: Pool | PoolClient, workItemId: string, logicalKey: string) {
  return queryOne<ArtifactRow>(
    db,
    `SELECT logical_key, artifact_order, kind, input_fingerprint, payload_hash,
            CASE WHEN octet_length(envelope) <= $3 THEN envelope ELSE '' END AS envelope,
            reserved_bytes
       FROM review_run_artifacts WHERE work_item_id = $1 AND logical_key = $2`,
    [workItemId, logicalKey, REVIEW_ARTIFACT_BUDGET_BYTES],
  );
}

async function lockRunningReview(
  client: PoolClient,
  binding: ReviewArtifactBinding,
  leaseEpoch: number | null,
) {
  if (leaseEpoch === null || !Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0) {
    throw new AppError({
      domain: "agent_work",
      kind: "pr_actor_lease_lost",
      message: "Review artifact writes require a numeric execution epoch",
      context: { workItemId: binding.workItemId },
    });
  }
  // Match admission and intake's lease-first ordering. The later item read sees
  // cancellation committed while lease acquisition was waiting.
  await lockPrActorLeaseForUpdate(client, binding.workItemId, leaseEpoch);
  const item = await queryOne<{
    type: string;
    status: string;
    cancel_requested_at: Date | null;
    execution_epoch: string | null;
    resource_key: string;
    owner: string;
    repo: string;
    pr_number: number;
    installation_id: string;
    head_sha: string;
    review_lens: string | null;
  }>(
    client,
    `SELECT type, status, cancel_requested_at, execution_epoch, resource_key,
            owner, repo, pr_number, installation_id, head_sha, review_lens
       FROM agent_work_items WHERE id = $1 FOR UPDATE`,
    [binding.workItemId],
  );
  if (!item || item.status !== "running" || item.cancel_requested_at !== null) {
    throw new AppError({
      domain: "agent_work",
      kind: "execution_aborted",
      message: "Review artifact write stopped because the work is no longer active",
      context: { workItemId: binding.workItemId },
    });
  }
  if (Number(item.execution_epoch) !== leaseEpoch) {
    throw new AppError({
      domain: "agent_work",
      kind: "pr_actor_lease_lost",
      message: "Review artifact execution epoch no longer matches",
      context: { workItemId: binding.workItemId, leaseEpoch },
    });
  }
  if (
    item.type !== "review" ||
    item.review_lens !== "review" ||
    item.resource_key !== binding.resourceKey ||
    item.owner !== binding.owner ||
    item.repo !== binding.repo ||
    item.pr_number !== binding.prNumber ||
    Number(item.installation_id) !== binding.installationId ||
    item.head_sha !== binding.headSha
  )
    reviewArtifactInvalid("artifact_identity");
}

async function dependencyMismatch(db: Pool | PoolClient, envelope: ReviewArtifactEnvelope) {
  const pending = [envelope];
  const loaded = new Map([[envelope.logicalKey, envelope]]);
  let bytes = Buffer.byteLength(encodeReviewArtifact(envelope), "utf8");
  async function readPrior(logicalKey: string) {
    const cached = loaded.get(logicalKey);
    if (cached) return cached;
    const row = await artifactRow(db, envelope.binding.workItemId, logicalKey);
    if (!row) return null;
    bytes += Buffer.byteLength(row.envelope, "utf8");
    if (bytes > REVIEW_ARTIFACT_BUDGET_BYTES) return null;
    const prior = decodeArtifact(row, envelope.binding);
    if (!prior) return null;
    loaded.set(logicalKey, prior);
    pending.push(prior);
    return prior;
  }
  // Every edge must descend in logical order, including implicit journal links.
  // Visit each key once without recursion; the byte budget bounds total traversal.
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const seen = new Set<string>();
    for (const dependency of reviewArtifactDependencies(current)) {
      if (seen.has(dependency.logicalKey)) return "artifact_dependency";
      seen.add(dependency.logicalKey);
      const prior = await readPrior(dependency.logicalKey);
      if (
        !prior ||
        prior.order >= current.order ||
        reviewArtifactHash(prior) !== dependency.payloadHash
      )
        return "artifact_dependency";
    }
    const artifact = current.artifact;
    if (artifact.kind === "publication_prepared" && artifact.sequence > 0) {
      const prior = await readPrior(`decision/${artifact.sequence - 1}/settled`);
      if (!prior || prior.order >= current.order || prior.artifact.kind !== "publication_settled")
        return "decision_order";
    } else if (artifact.kind === "publication_settled") {
      const prior = await readPrior(`decision/${artifact.sequence}/prepared`);
      if (!prior || prior.order >= current.order || prior.artifact.kind !== "publication_prepared")
        return "prepared_decision_missing";
      if (
        prior.artifact.decisionId !== artifact.decisionId ||
        reviewArtifactHash(prior) !== artifact.preparedHash
      )
        return "prepared_decision_mismatch";
    }
  }
  return null;
}

export type ReviewArtifactStore = {
  /** Current matching envelopes only. Reads do not grant evidence or remote acceptance. */
  load: (logicalKey: string) => Promise<ReviewArtifactEnvelope | null>;
  /** "capacity"/"incompatible" disable new caching; other failures throw. */
  save: (envelope: unknown) => Promise<ReviewArtifactWriteResult>;
};

/** Flag gating belongs to the review consumer. FK retention is unconditional. */
export function openReviewArtifactStore(
  pool: Pool,
  binding: ReviewArtifactBinding,
  leaseEpoch: number | null,
): ReviewArtifactStore {
  // Snapshot the caller's binding so later object mutation cannot widen the store.
  const identity: ReviewArtifactBinding = { ...binding };
  return {
    async load(logicalKey) {
      const row = await artifactRow(pool, identity.workItemId, logicalKey);
      const envelope = row ? decodeArtifact(row, identity) : null;
      return envelope && !(await dependencyMismatch(pool, envelope)) ? envelope : null;
    },
    async save(value) {
      const envelope = parseReviewArtifactEnvelope(value);
      if (!envelope) reviewArtifactInvalid("artifact_schema");
      if (encodeReviewArtifact(envelope.binding) !== encodeReviewArtifact(identity)) {
        reviewArtifactInvalid("artifact_identity");
      }
      const encoded = encodeReviewArtifact(envelope);
      const encodedBytes = Buffer.byteLength(encoded, "utf8");
      const hash = reviewArtifactHash(envelope);
      return inTransaction(pool, async (client) => {
        await lockRunningReview(client, identity, leaseEpoch);
        const existing = await artifactRow(client, identity.workItemId, envelope.logicalKey);
        if (existing) {
          if (!decodeArtifact(existing, identity)) return "incompatible";
          if (existing.payload_hash !== hash || existing.envelope !== encoded)
            reviewArtifactInvalid("artifact_conflict");
          if (await dependencyMismatch(client, envelope)) return "incompatible";
          return "existing";
        }
        const mismatch = await dependencyMismatch(client, envelope);
        if (mismatch) reviewArtifactInvalid(mismatch);
        let preparedKey: string | null = null;
        let reserve = 0;
        let releasedReserve = 0;
        if (envelope.artifact.kind === "publication_prepared") {
          reserve = REVIEW_SETTLEMENT_RESERVE_BYTES;
        } else if (envelope.artifact.kind === "publication_settled") {
          const settled = envelope.artifact;
          preparedKey = `decision/${settled.sequence}/prepared`;
          const row = await artifactRow(client, identity.workItemId, preparedKey);
          const prepared = row ? decodeArtifact(row, identity) : null;
          if (!prepared || prepared.artifact.kind !== "publication_prepared") {
            reviewArtifactInvalid("prepared_decision_missing");
          }
          if (
            prepared.artifact.decisionId !== settled.decisionId ||
            row?.payload_hash !== settled.preparedHash ||
            row.reserved_bytes !== REVIEW_SETTLEMENT_RESERVE_BYTES ||
            encodedBytes > REVIEW_SETTLEMENT_RESERVE_BYTES
          ) {
            reviewArtifactInvalid("prepared_decision_mismatch");
          }
          releasedReserve = REVIEW_SETTLEMENT_RESERVE_BYTES;
        }
        const usage = await queryOne<{ bytes: string }>(
          client,
          `SELECT COALESCE(SUM(encoded_bytes + reserved_bytes), 0)::text AS bytes
             FROM review_run_artifacts WHERE work_item_id = $1`,
          [identity.workItemId],
        );
        // The item lock serializes the whole work budget, not just one logical key.
        if (
          Number(usage?.bytes ?? 0) + encodedBytes + reserve - releasedReserve >
          REVIEW_ARTIFACT_BUDGET_BYTES
        )
          return "capacity";
        if (preparedKey !== null) {
          await client.query(
            `UPDATE review_run_artifacts SET reserved_bytes = 0
              WHERE work_item_id = $1 AND logical_key = $2`,
            [identity.workItemId, preparedKey],
          );
        }
        await client.query(
          `INSERT INTO review_run_artifacts
             (work_item_id, logical_key, artifact_order, kind, input_fingerprint, payload_hash,
              envelope, reserved_bytes, prepared_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            identity.workItemId,
            envelope.logicalKey,
            envelope.order,
            envelope.artifact.kind,
            identity.inputFingerprint,
            hash,
            encoded,
            reserve,
            preparedKey,
          ],
        );
        return "stored";
      });
    },
  };
}
