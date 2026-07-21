import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { JUDGMENT_DEGRADED_NOTE, RUN_DEADLINE_NOTE } from "../../settings/index.js";
import type { ReviewFinding, ReviewPublishContext } from "../reviewSchema.js";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
} from "../findings/findingPipeline.js";
import { fingerprintFinding } from "../findings/reviewFindingFingerprint.js";
import {
  publishFindingBatch,
  type FindingBatchContext,
  type ThreadPublishRunState,
} from "../publish/publishFindingBatch.js";
import { publishReviewSummaryOnly } from "../publish/publishSummaryOnly.js";
import {
  downgradePlacementsAfterInlineFailure,
  planInlinePlacements,
  type InlinePlacement,
} from "../placement/reviewDiffPlacement.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import { refreshInstallationTokenIfNearExpiry } from "./refreshInstallationTokenIfNearExpiry.js";
import type { SpecialistId, SpecialistOutcome } from "./specialistReport.js";

function deterministicOverviewPayload(acceptedFindings: readonly ReviewFinding[]) {
  const blocking = acceptedFindings.filter((f) => f.severity === "P0" || f.severity === "P1");
  return {
    prCharacter:
      acceptedFindings.length === 0
        ? "No findings reported on this orchestrated pass."
        : "Deterministic summary after judgment degradation.",
    findings: [...acceptedFindings],
    estimatedEffort: 1,
    relevantTests: "no" as const,
    securityConcerns: null,
    followUps: [] as string[],
    mergeVerdict:
      blocking.length > 0
        ? {
            score: 2 as const,
            rationale: `${blocking.length} blocking finding(s) open on this pass (judgment degraded).`,
          }
        : {
            score: 4 as const,
            rationale: "No blocking findings on this pass (judgment degraded).",
          },
  };
}

export function coverageNotes(params: {
  readonly partialSpecialists: readonly string[];
  readonly judgmentDegraded: boolean;
  /** Pure time-budget path — never combined with judgment-degraded wording. */
  readonly deadlineReached?: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (params.partialSpecialists.length > 0) {
    parts.push(`Coverage partial: ${params.partialSpecialists.join(", ")} specialist(s) failed.`);
  }
  if (params.judgmentDegraded) {
    parts.push(JUDGMENT_DEGRADED_NOTE);
  } else if (params.deadlineReached) {
    parts.push(RUN_DEADLINE_NOTE);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function appendAcceptedFindings(
  runState: ThreadPublishRunState,
  findings: readonly ReviewFinding[],
): void {
  const existing = new Set(
    runState.acceptedFindings.map((finding) => fingerprintFinding(finding, "review")),
  );
  for (const finding of findings) {
    const fingerprint = fingerprintFinding(finding, "review");
    if (existing.has(fingerprint)) continue;
    existing.add(fingerprint);
    runState.acceptedFindings.push(finding);
  }
}

function appendSummaryPlacements(
  runState: ThreadPublishRunState,
  placements: readonly InlinePlacement[],
): void {
  if (runState.summaryPlacements == null) runState.summaryPlacements = [];
  runState.summaryPlacements.push(...placements);
}

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
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs?: () => number | undefined;
  readonly refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  readonly refreshNearExpiry?: () => Promise<void>;
  readonly recordPublishStep: RecordPublishStepWithCoordination;
  readonly runState: ThreadPublishRunState;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly shouldAbortPublish?: FindingBatchContext["shouldAbortPublish"];
  readonly publishAbortState?: FindingBatchContext["publishAbortState"];
}): Promise<void> {
  await refreshInstallationTokenIfNearExpiry({
    getTokenExpiresAtTs: params.getTokenExpiresAtTs,
    refreshInstallationToken: params.refreshInstallationToken,
    refreshNearExpiry: params.refreshNearExpiry,
  });
  await publishFindingBatch(params.outcome.report.findings, {
    cfg: params.cfg,
    ctx: params.ctx,
    getToken: params.getToken,
    cachedDiffIndex: params.cachedDiffIndex,
    recordPublishStep: params.recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    runState: params.runState,
    tokenExpiresAtTs: params.getTokenExpiresAtTs?.(),
  });
}

/** Deterministic final summary from accepted findings (decision 19 / deadline). */
export async function publishDeterministicSummary(params: {
  readonly cfg: Pick<Config, "piModel" | "features">;
  readonly ctx: ReviewPublishContext;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs?: () => number | undefined;
  readonly refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  readonly refreshNearExpiry?: () => Promise<void>;
  readonly recordPublishStep: RecordPublishStepWithCoordination;
  readonly runState: ThreadPublishRunState;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly partialSpecialists: readonly SpecialistId[] | readonly string[];
  readonly judgmentDegraded: boolean;
  readonly deadlineReached?: boolean;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly publishAbortState?: { staleHead?: boolean };
  readonly shouldLinkToSummary?: boolean;
  readonly summaryCommentIdHint?: number | null;
}): Promise<{ summaryCommentId: number }> {
  await refreshInstallationTokenIfNearExpiry({
    getTokenExpiresAtTs: params.getTokenExpiresAtTs,
    refreshInstallationToken: params.refreshInstallationToken,
    refreshNearExpiry: params.refreshNearExpiry,
  });

  const acceptedFindings = [...params.runState.acceptedFindings];
  const summaryPlacements =
    params.runState.summaryPlacements != null && params.runState.summaryPlacements.length > 0
      ? params.runState.summaryPlacements
      : planInlinePlacements(acceptedFindings, params.cachedDiffIndex);

  return publishReviewSummaryOnly({
    cfg: params.cfg,
    ctx: params.ctx,
    getToken: params.getToken,
    getTokenExpiresAtTs: params.getTokenExpiresAtTs,
    refreshNearExpiry: params.refreshNearExpiry,
    payload: deterministicOverviewPayload(acceptedFindings),
    summaryPlacements,
    inlineReviewIds: params.runState.inlineReviewIds,
    recordPublishStep: params.recordPublishStep,
    partialCoverageNote: coverageNotes({
      partialSpecialists: params.partialSpecialists,
      judgmentDegraded: params.judgmentDegraded,
      deadlineReached: params.deadlineReached,
    }),
    coveragePartial: params.partialSpecialists.length > 0,
    cachedDiffIndex: params.cachedDiffIndex,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    shouldLinkToSummary: params.shouldLinkToSummary,
    summaryCommentIdHint: params.summaryCommentIdHint,
  });
}
