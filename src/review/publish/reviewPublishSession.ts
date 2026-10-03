import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { AgentEventsContext } from "../../agent/runtime/agentEventSink.js";
import type { OperationIntentContext } from "../../agentWork/publishOnce.js";
import type { Config, AnyReviewLens } from "../../settings/index.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import type { ReviewPublishContext } from "../reviewSchema.js";
import type { RecordPublishStepWithCoordination } from "./reviewSummaryComment.js";
import type { ReviewRecovery } from "../recovery/reviewRecovery.js";

export type PublishStopReason = "superseded" | "stale_head";

export type ReviewPublishConfig = Pick<
  Config,
  "models" | "features" | "agentEvents" | "findingHistory" | "review"
>;

type VerdictTarget = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly leaseEpoch: number | null | undefined;
};

/**
 * Everything the two review publishers share for one run: identity, the summary
 * coordination record, and the single abort policy. Per-call inputs (findings,
 * ledger, payload, coverage) stay with the caller.
 */
export type ReviewPublishSession = {
  readonly recovery?: ReviewRecovery;
  readonly cfg: ReviewPublishConfig;
  readonly ctx: ReviewPublishContext;
  readonly mode: AnyReviewLens;
  readonly prSurface: PrSurface;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly shouldLinkToSummary?: boolean;
  readonly progressCommentIdHint?: number | null;
  readonly recordPublishStep?: RecordPublishStepWithCoordination;
  readonly agentEvents?: AgentEventsContext;
  /** Identity stored on inline batch records; absent when no batch record is wanted. */
  readonly workItemId?: string;
  readonly operationIntent?: OperationIntentContext;
  readonly pool?: Pool;
  readonly installationId?: number;
  readonly boss?: PgBoss;
  /** Where the own verdict closes after the summary lands. */
  readonly verdict?: VerdictTarget;
  readonly resolveProgressCommentUrl: () => Promise<string | undefined>;
  /**
   * Returns why publication must stop, or undefined to continue. A failing check
   * propagates so the durable job retries; it never reads as supersession and
   * never authorizes publication.
   */
  readonly stopReason: () => Promise<PublishStopReason | undefined>;
};

export type ReviewPublishSessionInput = {
  readonly recovery?: ReviewRecovery;
  readonly cfg: ReviewPublishConfig;
  readonly ctx: ReviewPublishContext;
  readonly prSurface: PrSurface;
  readonly mode?: AnyReviewLens;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly shouldLinkToSummary?: boolean;
  readonly progressCommentIdHint?: number | null;
  readonly recordPublishStep?: RecordPublishStepWithCoordination;
  readonly agentEvents?: AgentEventsContext;
  readonly workItemId?: string;
  readonly operationIntent?: OperationIntentContext;
  readonly pool?: Pool;
  readonly installationId?: number;
  readonly boss?: PgBoss;
  readonly verdictWorkItemId?: string;
  readonly verdictResourceKey?: string;
  readonly verdictLeaseEpoch?: number | null;
  readonly resolveProgressCommentUrl?: () => Promise<string | undefined>;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly publishAbortState?: { readonly staleHead?: boolean };
};

export function createReviewPublishSession(input: ReviewPublishSessionInput): ReviewPublishSession {
  const coordination = input.recordPublishStep?.summaryCommentCoordination;
  const verdictPool = input.pool ?? coordination?.pool;
  const verdictWorkItemId = input.verdictWorkItemId ?? coordination?.workItemId;
  const verdictResourceKey = input.verdictResourceKey ?? coordination?.resourceKey;
  return {
    recovery: input.recovery,
    cfg: input.cfg,
    ctx: input.ctx,
    mode: input.mode ?? "review",
    prSurface: input.prSurface,
    cachedDiffIndex: input.cachedDiffIndex,
    shouldLinkToSummary: input.shouldLinkToSummary,
    progressCommentIdHint: input.progressCommentIdHint,
    recordPublishStep: input.recordPublishStep,
    agentEvents: input.agentEvents,
    workItemId: input.workItemId,
    operationIntent: input.operationIntent,
    pool: input.pool,
    installationId: input.installationId,
    boss: input.boss,
    verdict:
      verdictPool != null && verdictWorkItemId != null && verdictResourceKey != null
        ? {
            pool: verdictPool,
            workItemId: verdictWorkItemId,
            resourceKey: verdictResourceKey,
            leaseEpoch: coordination != null ? coordination.leaseEpoch : input.verdictLeaseEpoch,
          }
        : undefined,
    resolveProgressCommentUrl: input.resolveProgressCommentUrl ?? (async () => undefined),
    stopReason: async () => {
      if (!((await input.shouldAbortPublish?.()) ?? false)) return undefined;
      return input.publishAbortState?.staleHead === true ? "stale_head" : "superseded";
    },
  };
}
