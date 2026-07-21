import type { Config } from "../../config.js";
import { logInfo } from "../../evlog.js";
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";
import { JUDGMENT_DEGRADED_NOTE } from "../../settings/index.js";
import type { ReviewFinding, ReviewPayload, ReviewPublishContext } from "../reviewSchema.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import { publishReviewSummaryOnly } from "../publish/publishSummaryOnly.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import type { ThreadPublishRunState } from "../publish/threadPublishRunState.js";
import { coverageNotes } from "./coverageNotes.js";
import type { CapturedSummaryOverview } from "./publishSummaryTool.js";
import type { RunAbortScope } from "./runAbortScope.js";

/** Why the host fell back to a deterministic overview (mirrors coverage-note priority). */
export type DeterministicOverviewReason = "deadline" | "judgment_degraded";

/** Overview fields for a deterministic summary when LLM capture is missing or forced. */
export function deterministicOverviewPayload(
  acceptedFindings: readonly ReviewFinding[],
  reason: DeterministicOverviewReason,
): ReviewPayload {
  const blocking = acceptedFindings.filter((f) => f.severity === "P0" || f.severity === "P1");
  const afterReason =
    reason === "deadline"
      ? "Deterministic summary after run deadline."
      : "Deterministic summary after judgment degradation.";
  const parenthetical = reason === "deadline" ? "run deadline" : "judgment degraded";
  return {
    prCharacter:
      acceptedFindings.length === 0
        ? "No findings reported on this orchestrated pass."
        : afterReason,
    findings: [...acceptedFindings],
    estimatedEffort: 1,
    relevantTests: "no",
    securityConcerns: null,
    followUps: [],
    mergeVerdict:
      blocking.length > 0
        ? {
            score: 2,
            rationale: `${blocking.length} blocking finding(s) open on this pass (${parenthetical}).`,
          }
        : {
            score: 4,
            rationale: `No blocking findings on this pass (${parenthetical}).`,
          },
  };
}

export type FinalizeReviewSummaryParams = {
  readonly cfg: Pick<Config, "piModel" | "features">;
  readonly ctx: ReviewPublishContext;
  readonly token: InstallationTokenHandle;
  readonly recordPublishStep: RecordPublishStepWithCoordination;
  readonly runState: ThreadPublishRunState;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly abort: RunAbortScope;
  /** LLM-captured overview from `publish_summary`, or null when missing/invalid. */
  readonly capturedOverview: CapturedSummaryOverview | null;
  /** When true, ignore capture and publish the deterministic overview. */
  readonly forceDeterministic: boolean;
  readonly judgmentDegraded: boolean;
  readonly deadlineReached: boolean;
  /** Log synthesis-degraded only when falling back after a failed LLM synthesis path. */
  readonly logSynthesisDegraded?: boolean;
  readonly shouldLinkToSummary?: boolean;
  readonly summaryCommentIdHint?: number | null;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
};

/**
 * Single production call site for {@link publishReviewSummaryOnly}.
 * Chooses captured LLM overview or deterministic overview; never publishes on supersede.
 * Sole owner of coverage-note computation from run state + deadline/session health.
 */
export async function finalizeReviewSummary(
  params: FinalizeReviewSummaryParams,
): Promise<{ readonly published: boolean; readonly summaryCommentId?: number }> {
  if (params.abort.isSuperseded()) {
    return { published: false };
  }
  const gate = await params.abort.gate();
  if (gate === "superseded" || params.abort.isSuperseded()) {
    return { published: false };
  }

  const acceptedFindings = [...params.runState.acceptedFindings];
  const captured = params.capturedOverview;
  const deadlineOnly = params.deadlineReached && !params.judgmentDegraded;
  const deterministicReason: DeterministicOverviewReason = deadlineOnly
    ? "deadline"
    : "judgment_degraded";
  const payload =
    !params.forceDeterministic && captured != null
      ? { ...captured, findings: acceptedFindings }
      : deterministicOverviewPayload(acceptedFindings, deterministicReason);

  const partialCoverageNote = coverageNotes({
    partialSpecialists: params.runState.partialSpecialists,
    judgmentDegraded: params.judgmentDegraded,
    deadlineReached: deadlineOnly,
  });

  const result = await publishReviewSummaryOnly({
    cfg: params.cfg,
    ctx: params.ctx,
    token: params.token,
    payload,
    summaryPlacements: params.runState.summaryPlacements,
    inlineReviewIds: params.runState.inlineReviewIds,
    recordPublishStep: params.recordPublishStep,
    partialCoverageNote,
    coveragePartial: params.runState.partialSpecialists.length > 0,
    cachedDiffIndex: params.cachedDiffIndex,
    abortGate: params.abort.publishGate,
    shouldLinkToSummary: params.shouldLinkToSummary,
    summaryCommentIdHint: params.summaryCommentIdHint,
  });

  if (params.logSynthesisDegraded) {
    logInfo("review_synthesis_degraded", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      note: JUDGMENT_DEGRADED_NOTE,
    });
  }

  return { published: true, summaryCommentId: result.summaryCommentId };
}
