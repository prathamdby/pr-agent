import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import type { ReviewPublishContext } from "../reviewSchema.js";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
} from "../findings/findingPipeline.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import { downgradePlacementsAfterInlineFailure } from "../placement/reviewDiffPlacement.js";
import { publishFindingBatch } from "../publish/publishFindingBatch.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import {
  appendAcceptedFindings,
  appendSummaryPlacements,
  type ThreadPublishRunState,
} from "../publish/threadPublishRunState.js";
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";
import type { PublishAbortGate } from "../publish/publishAbortGate.js";
import type { SpecialistOutcome } from "./specialistReport.js";

/**
 * Validate and retain an unjudged specialist report as summary-only without a GitHub review
 * call — used once the internal run deadline has consumed the judgment budget (20% reserve).
 */
export function accumulateUnjudgedReportAsSummaryOnly(params: {
  readonly outcome: Extract<SpecialistOutcome, { kind: "report" }>;
  readonly runState: ThreadPublishRunState;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
}): void {
  const prepared = prepareReviewPayloadForPublish({
    payload: {
      prCharacter: "Incremental review findings.",
      findings: [...params.outcome.report.findings],
      estimatedEffort: 1,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    },
    mode: "review",
    cachedDiffIndex: params.cachedDiffIndex,
    // Summary-only retention: unresolved anchors stay in the summary table, never inline.
    enforceInlineAnchorValidation: false,
  });
  if (!prepared.ok) {
    throw new AppError({
      code: "review.finding_batch_validation_failed",
      message: prepared.error,
      context: { anchorFailureCount: prepared.anchorFailures.length },
    });
  }

  const targets = prepareFindingsForPublish({
    payload: prepared.prepared.payload,
    mode: "review",
    cachedDiffIndex: params.cachedDiffIndex,
    inlinePlacements: prepared.prepared.placements,
    storedInlineFingerprints: [...params.runState.postedFingerprints],
    maxInlineComments: 0,
  });

  appendAcceptedFindings(params.runState, prepared.prepared.payload.findings);
  appendSummaryPlacements(
    params.runState,
    downgradePlacementsAfterInlineFailure(targets.placements),
  );
}

/** Publish one unjudged specialist report through the deterministic batch path. */
export async function publishUnjudgedReport(params: {
  readonly outcome: Extract<SpecialistOutcome, { kind: "report" }>;
  readonly cfg: Pick<Config, "piModel" | "features">;
  readonly ctx: ReviewPublishContext;
  readonly token: InstallationTokenHandle;
  readonly recordPublishStep: RecordPublishStepWithCoordination;
  readonly runState: ThreadPublishRunState;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly abortGate: PublishAbortGate;
}): Promise<void> {
  await publishFindingBatch(params.outcome.report.findings, {
    cfg: params.cfg,
    ctx: params.ctx,
    token: params.token,
    cachedDiffIndex: params.cachedDiffIndex,
    recordPublishStep: params.recordPublishStep,
    abortGate: params.abortGate,
    runState: params.runState,
  });
}
