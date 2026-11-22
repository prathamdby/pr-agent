import { decodeProgressComment } from "../github/prSurfaceResults.ts";
import { evaluateTrivialChangeExemption } from "../review/run/reviewChangeGate.ts";
import type { ReviewPreflightMetadata } from "../review/placement/reviewPreflightFiles.ts";
import { createReviewSummaryComment } from "../review/publish/reviewSummaryComment.ts";
import { tryPublishCloseOutcomeReview } from "../review/publish/publishCloseOutcomeReview.ts";
import { renderLightweightReviewCompletion } from "../review/run/reviewRender.ts";
import { resolveReviewWallClockMs } from "../review/run/reviewRunFooter.ts";
import { snapshotReviewRunMetrics } from "../review/run/reviewRunMetrics.ts";
import { REVIEW_SUMMARY_SENTINEL, type ReviewMode } from "../review/reviewSchema.ts";
import type { PrSurface } from "../github/prSurface.ts";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.ts";
import { recoverMarkedProgressComment } from "../github/recoverPrSurfaceMutation.ts";
import { summaryCommentVerdictMeta } from "./reviewVerdict.ts";
import type { ReviewWorkItem } from "./types.ts";
import {
  latestCommentGithubId,
  operationIntentMarker,
  progressStubPostedAtMs,
  publishOnce,
  reviewSummaryOperationKey,
  writePublishStep,
} from "../state/publish.ts";
import type {
  ReviewHeadCiPort,
  ReviewPublishTarget,
} from "../review/publish/reviewPublishSession.ts";
import { waitingCiSummary } from "../review/ci/ciFacts.ts";
import { loadFindingInventoryOrUnavailable } from "../review/findingIdentity/findingInventory.ts";
import {
  buildFindingView,
  findingCheck,
  renderFindingsSection,
  type FindingCheck,
} from "../review/findingIdentity/findingLifecycle.ts";
import { REVIEW_SUMMARY_BODY_MAX_CHARS } from "../settings/index.ts";

export type LightweightAutoReviewResult =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly published: false;
      readonly reason: "skipped";
    }
  | {
      readonly handled: true;
      readonly published: true;
      readonly summaryId: number | string;
      readonly check: FindingCheck;
    };

export async function tryLightweightAutoReviewCompletion(
  target: ReviewPublishTarget,
  params: {
    item: Pick<
      ReviewWorkItem,
      "id" | "source" | "owner" | "repo" | "prNumber" | "headSha" | "resourceKey"
    >;
    reviewLens: ReviewMode;
    prSurface: PrSurface;
    preflight: ReviewPreflightMetadata;
    model: string;
    headCi?: ReviewHeadCiPort;
    isCurrent: () => boolean;
    checkFailSeverity: "P0" | "P1" | "P2" | "P3";
  },
) {
  if (params.item.source !== "auto")
    return ((pinnedReturn: LightweightAutoReviewResult | Promise<LightweightAutoReviewResult>) =>
      pinnedReturn)({ handled: false });

  const trivial = evaluateTrivialChangeExemption({
    files: params.preflight.files,
    truncated: params.preflight.truncated,
  });
  if (!trivial.exempt)
    return ((pinnedReturn: LightweightAutoReviewResult | Promise<LightweightAutoReviewResult>) =>
      pinnedReturn)({ handled: false });

  if (!params.isCurrent()) {
    return ((pinnedReturn: LightweightAutoReviewResult | Promise<LightweightAutoReviewResult>) =>
      pinnedReturn)({ handled: true, published: false, reason: "skipped" });
  }

  const metricsSnapshot = snapshotReviewRunMetrics();
  const renderedCi = (await params.headCi?.load(params.item.headSha)) ?? waitingCiSummary(0);
  const findingView = buildFindingView(
    await loadFindingInventoryOrUnavailable(params.prSurface, {
      renames: new Map(),
      deletedPaths: new Set(),
    }),
    { kind: "not_reviewed" },
    params.checkFailSeverity,
  );
  const check = findingCheck(findingView);
  const footer = {
    headSha: params.item.headSha,
    durationMs: resolveReviewWallClockMs({
      stubPostedAtMs: progressStubPostedAtMs(
        target.db,
        params.item.resourceKey,
        params.reviewLens,
        target.workItemId,
      ),
      metricsStartedAtMs: metricsSnapshot?.startedAtMs,
      endedAtMs: Date.now(),
    }),
    model: params.model,
  };
  const ciOptions = { ciSummary: renderedCi.summary, ciVersion: renderedCi.version };
  const sentinel = REVIEW_SUMMARY_SENTINEL;
  const operationKey = reviewSummaryOperationKey(params.item.resourceKey, params.reviewLens);
  const operationMarker = operationIntentMarker(operationKey, params.item.id);
  const withMarker = (body: string) => `${body}\n${operationMarker}`;
  const sectionSeparators = "\n\n";
  const findingsBudget =
    REVIEW_SUMMARY_BODY_MAX_CHARS -
    withMarker(renderLightweightReviewCompletion(footer, ciOptions)).length -
    sectionSeparators.length;
  const bodyWithMarker = withMarker(
    renderLightweightReviewCompletion(footer, {
      ...ciOptions,
      findingsSection: renderFindingsSection(findingView, findingsBudget),
    }),
  );
  const storedId = latestCommentGithubId(target.db, params.item.resourceKey, params.reviewLens);
  const knownExisting = await params.prSurface.resolveProgressComment(sentinel, storedId);
  const summary = await publishOnce<{
    readonly id: number;
    readonly updated: boolean;
  }>({
    decodeResult: decodeProgressComment,
    db: target.db,
    workId: target.workItemId,
    prKey: target.resourceKey,
    resourceTarget: `summary_comment:${params.reviewLens}`,
    ...(target.laneEpoch !== undefined ? { laneEpoch: target.laneEpoch } : {}),
    ...(target.shutdownRequested !== undefined
      ? { shutdownRequested: target.shutdownRequested }
      : {}),
    operationKey,
    mutationKind: "github.review_summary_comment",
    identity: {
      step: "summary_comment",
      resourceKey: params.item.resourceKey,
      reviewLens: params.reviewLens,
      operationMarker,
    },
    recover: async () => {
      const recovered = await recoverMarkedProgressComment(params.prSurface, {
        operationMarker,
        sentinel,
        knownExistingId: knownExisting?.id,
      });
      return recovered.kind === "reconciled"
        ? { found: true as const, value: recovered.value }
        : { found: false as const };
    },
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    mutate: () =>
      createReviewSummaryComment({
        prSurface: params.prSurface,
        reviewLens: params.reviewLens,
        coordination: target,
      }).conclude({
        body: bodyWithMarker,
        hintCommentId: knownExisting?.id ?? storedId,
        ciHeadSha: params.item.headSha,
        ciVersion: renderedCi.version,
      }),
  });
  params.headCi?.requestProjection(params.item.headSha, renderedCi.version);
  writePublishStep(target.db, {
    workId: target.workItemId,
    prKey: target.resourceKey,
    reviewLens: params.reviewLens,
    step: "summary_comment",
    githubId: summary.id,
    detail: {
      lightweightCompletion: true,
      trivialReason: "docs_only",
      ...summaryCommentVerdictMeta({
        kind: "published",
        conclusion: check.conclusion,
        checkFailSeverity: params.checkFailSeverity,
      }),
    },
  });
  await tryPublishCloseOutcomeReview({
    prSurface: params.prSurface,
    outcome: { kind: "published", ...check },
    headSha: params.item.headSha,
    summaryCommentId: summary.id,
    target,
    reviewLens: params.reviewLens,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
  });
  return ((pinnedReturn: LightweightAutoReviewResult | Promise<LightweightAutoReviewResult>) =>
    pinnedReturn)({ handled: true, published: true, summaryId: summary.id, check });
}
