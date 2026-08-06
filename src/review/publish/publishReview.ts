import type { Config } from "../../config.js";
import { reviewCheckDetailsUrl } from "../../agentWork/reviewCheckRun.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import { createCachedPrDiffIndex, type CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import type { AcceptedPlacement } from "../orchestrator/orchestratorTypes.js";
import { applyFindingLedgerDelta, createFindingLedger } from "../orchestrator/orchestratorTypes.js";
import type { CiSummaryAuthor } from "../ci/authorCiSummary.js";
import type { ReviewPayload, ReviewPublishContext } from "../reviewSchema.js";
import type { SubmitReviewState } from "./submitReviewTool.js";
import { publishFindingBatch } from "./publishFindingBatch.js";
import {
  publishReviewSummaryOnly,
  type RecordPublishStepWithCoordination,
} from "./publishSummaryOnly.js";

export {
  attachSummaryCommentCoordination,
  upsertSummaryCommentWithCreationClaim,
} from "./publishSummaryOnly.js";

export async function publishReview(
  params: ReviewPublishContext & {
    token: string;
    getToken?: () => string;
    getTokenExpiresAtTs?: () => number | undefined;
    mode?: AnyReviewLens;
    cfg: Pick<Config, "piModel" | "features">;
    payload: ReviewPayload;
    tokenExpiresAtTs?: number;
    dedupedFindingCount?: number;
    publishState: SubmitReviewState;
    cachedDiffIndex?: CachedPrDiffIndex;
    shouldLinkToSummary?: boolean;
    progressCommentIdHint?: number | null;
    staleReview?: boolean;
    recordPublishStep?: RecordPublishStepWithCoordination;
    storedInlineFingerprints?: readonly string[];
    ciSummaryAuthor?: CiSummaryAuthor;
    workItemId?: string;
    resumedPlacements?: readonly AcceptedPlacement[];
    shouldAbortPublish?: () => Promise<boolean>;
    publishAbortState?: { readonly staleHead?: boolean };
  },
): Promise<void> {
  const resumedPlacements = params.resumedPlacements ?? [];
  let ledger = createFindingLedger({
    accepted: resumedPlacements,
    suppressionFingerprints: params.storedInlineFingerprints,
    inlineReviewIds: params.publishState.inlineReviewIds,
    postedInlineCount: resumedPlacements.length,
    threadCallCount: params.publishState.threadCallCount,
  });
  const getToken = params.getToken ?? (() => params.token);
  const getTokenExpiresAtTs = params.getTokenExpiresAtTs ?? (() => params.tokenExpiresAtTs);
  const batchResult = await publishFindingBatch(params.payload.findings, {
    ctx: params,
    source: "review",
    workItemId:
      params.workItemId ?? params.recordPublishStep?.summaryCommentCoordination?.workItemId,
    operationIntent: params.recordPublishStep?.summaryCommentCoordination
      ? {
          client: params.recordPublishStep.summaryCommentCoordination.pool,
          workItemId: params.recordPublishStep.summaryCommentCoordination.workItemId,
          resourceKey: params.recordPublishStep.summaryCommentCoordination.resourceKey,
        }
      : undefined,
    resolveProgressCommentUrl: async () =>
      reviewCheckDetailsUrl(
        params.owner,
        params.repo,
        params.prNumber,
        params.progressCommentIdHint,
      ),
    getToken,
    getTokenExpiresAtTs,
    cachedDiffIndex: params.cachedDiffIndex ?? createCachedPrDiffIndex(),
    recordPublishStep: params.recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    ledger,
  });
  if (batchResult.kind === "stopped") {
    params.publishState.publishSuperseded = true;
    return;
  }

  ledger = applyFindingLedgerDelta(ledger, batchResult.delta);
  params.publishState.inlineReviewIds = [...ledger.inlineReviewIds];
  params.publishState.threadCallCount = ledger.threadCallCount;

  const summaryResult = await publishReviewSummaryOnly({
    cfg: params.cfg,
    ctx: params,
    getToken,
    getTokenExpiresAtTs,
    payload: params.payload,
    ledger,
    mode: params.mode,
    cachedDiffIndex: params.cachedDiffIndex,
    shouldLinkToSummary: params.shouldLinkToSummary,
    progressCommentIdHint: params.progressCommentIdHint,
    staleReview: params.staleReview,
    recordPublishStep: params.recordPublishStep,
    ciAuthor: params.ciSummaryAuthor,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    dedupedFindingCount: params.dedupedFindingCount,
  });
  if (summaryResult.kind === "stopped") {
    params.publishState.publishSuperseded = true;
  }
}
