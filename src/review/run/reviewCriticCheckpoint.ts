/**
 * Durable critic and payload checkpoints for the hybrid Review pipeline (KTD5, KTD8).
 * Checkpoints are keyed on work item, head SHA, evidence hash, critic ID, and
 * prompt-contract version; any component mismatch means the artifact is unusable.
 */

export type ReviewCriticCheckpointScope = {
  readonly workItemId: string;
  readonly headSha: string;
  readonly evidenceHash: string;
  readonly promptContractVersion: number;
};

export type ReviewCriticCheckpointKey = ReviewCriticCheckpointScope & {
  readonly criticId: string;
};

export type ReviewCriticCheckpointStatus = "in_progress" | "completed" | "exhausted";

export type ReviewCriticCheckpointState = {
  readonly status: ReviewCriticCheckpointStatus;
  readonly attemptCount: number;
  readonly report: Record<string, unknown> | null;
};

export type ReviewCriticAttemptClaim = {
  /** Total attempts recorded for this checkpoint after the claim. */
  readonly attemptCount: number;
  /** False when the checkpoint is already completed and must be reused instead. */
  readonly claimed: boolean;
};

export interface ReviewCriticCheckpointStore {
  loadCheckpoints(
    scope: ReviewCriticCheckpointScope,
  ): Promise<ReadonlyMap<string, ReviewCriticCheckpointState>>;
  /** Atomically record one attempt; never increments a completed checkpoint. */
  claimAttempt(key: ReviewCriticCheckpointKey): Promise<ReviewCriticAttemptClaim>;
  /** Idempotent completion; a completed report can never be replaced. */
  saveCompletedReport(
    key: ReviewCriticCheckpointKey,
    report: Record<string, unknown>,
  ): Promise<void>;
  markExhausted(key: ReviewCriticCheckpointKey): Promise<void>;
}

export type ReviewPayloadCheckpoint = {
  readonly workItemId: string;
  readonly headSha: string;
  readonly evidenceHash: string;
  readonly promptContractVersion: number;
  readonly payload: Record<string, unknown>;
};

export interface ReviewPayloadCheckpointStore {
  load(workItemId: string): Promise<ReviewPayloadCheckpoint | null>;
  /**
   * Persist the validated payload once; returns the stored checkpoint, which is
   * the pre-existing one when a payload was already captured for the work item.
   */
  saveOnce(checkpoint: ReviewPayloadCheckpoint): Promise<ReviewPayloadCheckpoint>;
}

export function criticCheckpointKeyId(key: ReviewCriticCheckpointKey): string {
  return [
    key.workItemId,
    key.headSha,
    key.evidenceHash,
    key.criticId,
    String(key.promptContractVersion),
  ].join("\u0000");
}

export function payloadCheckpointMatches(
  checkpoint: ReviewPayloadCheckpoint,
  scope: Pick<ReviewCriticCheckpointScope, "headSha" | "evidenceHash" | "promptContractVersion">,
): boolean {
  return (
    checkpoint.headSha === scope.headSha &&
    checkpoint.evidenceHash === scope.evidenceHash &&
    checkpoint.promptContractVersion === scope.promptContractVersion
  );
}

/** In-memory stores for tests and structurally non-publishing evaluation runs. */
export function createInMemoryReviewCheckpointStores(): {
  criticStore: ReviewCriticCheckpointStore;
  payloadStore: ReviewPayloadCheckpointStore;
} {
  const criticRows = new Map<
    string,
    {
      status: ReviewCriticCheckpointStatus;
      attemptCount: number;
      report: Record<string, unknown> | null;
    }
  >();
  const payloads = new Map<string, ReviewPayloadCheckpoint>();

  const criticStore: ReviewCriticCheckpointStore = {
    async loadCheckpoints(scope) {
      const out = new Map<string, ReviewCriticCheckpointState>();
      for (const [id, row] of criticRows) {
        const [workItemId, headSha, evidenceHash, criticId, version] = id.split("\u0000");
        if (
          workItemId === scope.workItemId &&
          headSha === scope.headSha &&
          evidenceHash === scope.evidenceHash &&
          Number(version) === scope.promptContractVersion &&
          criticId
        ) {
          out.set(criticId, { ...row });
        }
      }
      return out;
    },
    async claimAttempt(key) {
      const id = criticCheckpointKeyId(key);
      const existing = criticRows.get(id);
      if (existing?.status === "completed") {
        return { attemptCount: existing.attemptCount, claimed: false };
      }
      const attemptCount = (existing?.attemptCount ?? 0) + 1;
      criticRows.set(id, {
        status: "in_progress",
        attemptCount,
        report: existing?.report ?? null,
      });
      return { attemptCount, claimed: true };
    },
    async saveCompletedReport(key, report) {
      const id = criticCheckpointKeyId(key);
      const existing = criticRows.get(id);
      if (existing?.status === "completed") return;
      criticRows.set(id, {
        status: "completed",
        attemptCount: existing?.attemptCount ?? 1,
        report,
      });
    },
    async markExhausted(key) {
      const id = criticCheckpointKeyId(key);
      const existing = criticRows.get(id);
      if (!existing || existing.status === "completed") return;
      criticRows.set(id, { ...existing, status: "exhausted" });
    },
  };

  const payloadStore: ReviewPayloadCheckpointStore = {
    async load(workItemId) {
      return payloads.get(workItemId) ?? null;
    },
    async saveOnce(checkpoint) {
      const existing = payloads.get(checkpoint.workItemId);
      if (existing) return existing;
      payloads.set(checkpoint.workItemId, checkpoint);
      return checkpoint;
    },
  };

  return { criticStore, payloadStore };
}
