import type { ReviewArtifactStore } from "../../agentWork/reviewArtifactRepository.ts";
import { AppError } from "../../errors/appError.ts";
import type { FindingLedger, ReviewCoverage } from "../orchestrator/orchestratorTypes.ts";
import type {
  ReviewArtifact,
  ReviewArtifactBinding,
  ReviewArtifactEnvelope,
} from "./reviewArtifacts.ts";
import {
  createReviewArtifactEnvelope,
  reviewArtifactHash,
  reviewArtifactInvalid,
} from "./reviewArtifacts.ts";
import type { CanonicalReviewDecision, FindingLedgerSnapshot } from "./reviewRecoverySchema.ts";
import type { ReviewPayload } from "../reviewSchema.ts";

export type RecoveryDecision = {
  readonly prepared: ReviewArtifactEnvelope & {
    readonly artifact: Extract<
      ReviewArtifactEnvelope["artifact"],
      { kind: "publication_prepared" }
    > & { readonly canonical: CanonicalReviewDecision };
  };
  readonly settled: ReviewArtifactEnvelope | null;
};

export function snapshotFindingLedger(ledger: FindingLedger): FindingLedgerSnapshot {
  return {
    accepted: ledger.accepted.map((entry) => ({ ...entry, placement: { ...entry.placement } })),
    reaffirmed: ledger.reaffirmed.map((entry) => ({ ...entry, placement: { ...entry.placement } })),
    suppressedDismissedCount: ledger.suppressedDismissedCount,
    inlineReviewIds: [...ledger.inlineReviewIds],
    postedInlineCount: ledger.postedInlineCount,
    threadCallCount: ledger.threadCallCount,
    threadBudgetExhausted: ledger.threadBudgetExhausted,
  };
}

export type PublicationSettlement =
  | { readonly outcome: "accepted" | "recovered"; readonly githubId?: number }
  | { readonly outcome: "stopped" };

function publicationSettlement(
  githubIdOrSettlement?: number | PublicationSettlement,
): PublicationSettlement {
  if (typeof githubIdOrSettlement === "number") {
    return { outcome: "accepted", githubId: githubIdOrSettlement };
  }
  return githubIdOrSettlement ?? { outcome: "accepted" };
}

export type ReviewRecovery = ReturnType<typeof openReviewRecovery>;

export function openReviewRecovery(binding: ReviewArtifactBinding, store: ReviewArtifactStore) {
  let caching = true;
  let nextSequence = 0;
  let judgmentDegraded = false;
  let briefFallback = false;
  let currentCoverage: Extract<CanonicalReviewDecision, { kind: "threads" }>["coverage"] = {
    kind: "full",
  };
  let allowSavedSummary = true;
  let storageFailure: unknown;
  let unresolvedPublication: unknown;
  let pendingDecision: RecoveryDecision | null = null;
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      storageFailure = error;
      throw error;
    }
  };
  const save = async (artifact: ReviewArtifact): Promise<ReviewArtifactEnvelope | null> => {
    if (!caching) return null;
    const envelope = createReviewArtifactEnvelope(binding, artifact);
    const result = await guarded(() => store.save(envelope));
    if (result === "capacity" || result === "incompatible") {
      caching = false;
      return null;
    }
    return envelope;
  };
  const dependenciesFor = async (canonical: CanonicalReviewDecision) => {
    const keys = [
      "brief",
      ...(canonical.kind === "threads"
        ? [`report/${canonical.source}`]
        : ["report/correctness", "report/security", "report/quality", "report/tests"]),
      ...(nextSequence > 0 ? [`decision/${nextSequence - 1}/settled`] : []),
    ];
    const dependencies: { logicalKey: string; payloadHash: string }[] = [];
    for (const key of keys) {
      const envelope = await guarded(() => store.load(key));
      if (envelope)
        dependencies.push({ logicalKey: key, payloadHash: reviewArtifactHash(envelope) });
    }
    return dependencies;
  };
  return {
    binding,
    save,
    load: (key: string) => guarded(() => store.load(key)),
    throwIfFailed: () => {
      if (storageFailure !== undefined) throw storageFailure;
    },
    takeStorageFailure: () => {
      const failure = storageFailure;
      storageFailure = undefined;
      return failure;
    },
    rememberUnresolvedPublication: (error: unknown) => {
      if (pendingDecision == null || unresolvedPublication !== undefined) return;
      unresolvedPublication = error;
    },
    throwIfPublicationUnresolved: (
      kind: "publish_thread_failed" | "publish_summary_failed" = "publish_thread_failed",
    ) => {
      if (pendingDecision == null) return;
      if (unresolvedPublication !== undefined) throw unresolvedPublication;
      throw new AppError({
        domain: "review",
        kind,
        message: "A prepared publication is still unsettled",
        context: {
          reason: "pending_publication",
          operationKey: pendingDecision.prepared.artifact.operationKey,
        },
      });
    },
    disable: () => {
      caching = false;
    },
    discardEvidenceCache: () => {
      caching = false;
      allowSavedSummary = false;
    },
    canReuseSummary: () => allowSavedSummary,
    setBriefFallback: (value: boolean) => {
      briefFallback = value;
    },
    getBriefFallback: () => briefFallback,
    setCoverage: (value: ReviewCoverage) => {
      if (value.kind === "full") {
        currentCoverage = value;
        return;
      }
      if (value.kind === "none") {
        currentCoverage = { kind: "none", failed: [...value.failed] };
        return;
      }
      currentCoverage = {
        kind: "partial",
        note: value.note,
        ...(value.failed != null ? { failed: [...value.failed] } : {}),
        ...(value.paths != null ? { paths: [...value.paths] } : {}),
        ...(value.unjudged != null ? { unjudged: [...value.unjudged] } : {}),
      };
    },
    getCoverage: () => currentCoverage,
    setJudgmentDegraded: (value: boolean) => {
      judgmentDegraded = value;
    },
    getJudgmentDegraded: () => judgmentDegraded,
    async decisions(): Promise<RecoveryDecision[]> {
      pendingDecision = null;
      const decisions: RecoveryDecision[] = [];
      for (let sequence = 0; sequence <= 100_000; sequence++) {
        const prepared = await guarded(() => store.load(`decision/${sequence}/prepared`));
        if (!prepared) {
          nextSequence = sequence;
          break;
        }
        if (prepared.artifact.kind !== "publication_prepared" || !prepared.artifact.canonical) {
          caching = false;
          break;
        }
        const settled = await guarded(() => store.load(`decision/${sequence}/settled`));
        if (
          settled &&
          (settled.artifact.kind !== "publication_settled" ||
            settled.artifact.preparedHash !== reviewArtifactHash(prepared) ||
            settled.artifact.decisionId !== prepared.artifact.decisionId)
        ) {
          reviewArtifactInvalid("decision_settlement");
        }
        decisions.push({
          prepared: {
            ...prepared,
            artifact: { ...prepared.artifact, canonical: prepared.artifact.canonical },
          },
          settled,
        });
        judgmentDegraded ||= prepared.artifact.canonical.judgmentDegraded;
        briefFallback ||= prepared.artifact.canonical.briefFallback;
        nextSequence = sequence + 1;
        if (!settled) {
          pendingDecision = decisions.at(-1) ?? null;
          break;
        }
      }
      return decisions;
    },
    async prepare(
      payload: ReviewPayload,
      operationKey: string,
      canonical: CanonicalReviewDecision,
    ) {
      if (!caching) return null;
      if (pendingDecision) {
        const pending = pendingDecision;
        const candidate = createReviewArtifactEnvelope(binding, {
          ...pending.prepared.artifact,
          payload,
          operationKey,
          canonical,
        });
        return guarded(async () => {
          if (reviewArtifactHash(candidate) !== reviewArtifactHash(pending.prepared))
            reviewArtifactInvalid("pending_decision_conflict");
          return pending;
        });
      }
      const sequence = nextSequence;
      const prepared = await save({
        kind: "publication_prepared",
        sequence,
        decisionId: `decision-${sequence}`,
        operationKey,
        target: canonical.kind === "threads" ? "threads" : "summary",
        payload,
        canonical,
        dependencies: await dependenciesFor(canonical),
      });
      if (
        !prepared ||
        prepared.artifact.kind !== "publication_prepared" ||
        !prepared.artifact.canonical
      )
        return null;
      nextSequence += 1;
      unresolvedPublication = undefined;
      pendingDecision = {
        prepared: {
          ...prepared,
          artifact: { ...prepared.artifact, canonical: prepared.artifact.canonical },
        },
        settled: null,
      };
      return pendingDecision;
    },
    async settle(
      decision: RecoveryDecision | null,
      githubIdOrSettlement?: number | PublicationSettlement,
    ) {
      if (!decision || decision.settled) return;
      const { prepared } = decision;
      const settlement = publicationSettlement(githubIdOrSettlement);
      const githubId = settlement.outcome === "stopped" ? undefined : settlement.githubId;
      const result = await guarded(() =>
        store.save(
          createReviewArtifactEnvelope(binding, {
            kind: "publication_settled",
            sequence: prepared.artifact.sequence,
            decisionId: prepared.artifact.decisionId,
            preparedHash: reviewArtifactHash(prepared),
            outcome: settlement.outcome,
            ...(githubId === undefined
              ? {}
              : {
                  remote: { operationKey: prepared.artifact.operationKey, githubId },
                }),
          }),
        ),
      );
      if (result !== "stored" && result !== "existing")
        reviewArtifactInvalid("settlement_capacity");
      if (pendingDecision?.prepared.logicalKey === prepared.logicalKey) {
        pendingDecision = null;
        unresolvedPublication = undefined;
      }
    },
    async saveSummary(payload: ReviewPayload, inputs: CanonicalReviewDecision) {
      if (!caching) return null;
      const retained = await guarded(() => store.load("final-summary"));
      if (retained?.artifact.kind === "final_summary") {
        return save({ ...retained.artifact, payload, inputs });
      }
      return save({
        kind: "final_summary",
        payload,
        inputs,
        dependencies: await dependenciesFor(inputs),
      });
    },
  };
}

export async function settleRejectedPublication(
  recovery: ReviewRecovery | null | undefined,
  decision: RecoveryDecision | null,
  error: unknown,
): Promise<void> {
  if (recovery == null || decision == null) return;
  try {
    await recovery.settle(decision, { outcome: "stopped" });
  } catch (settlementError) {
    const latched = recovery.takeStorageFailure();
    if (error instanceof Error && error.cause == null) error.cause = latched ?? settlementError;
    recovery.rememberUnresolvedPublication(error);
    throw error;
  }
}
