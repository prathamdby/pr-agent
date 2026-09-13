import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { evaluateTrivialChangeExemption } from "../review/run/reviewChangeGate.js";
import type { ReviewPreflightMetadata } from "../review/placement/reviewPreflightFiles.js";
import { upsertSummaryCommentWithCreationClaim } from "../review/publish/summaryCommentUpsert.js";
import { renderLightweightReviewCompletion } from "../review/run/reviewRender.js";
import { resolveReviewWallClockMs } from "../review/run/reviewRunFooter.js";
import { snapshotReviewRunMetrics } from "../review/run/reviewRunMetrics.js";
import { REVIEW_SUMMARY_SENTINEL, type ReviewMode } from "../review/reviewSchema.js";
import type { PrSurface } from "../github/prSurface.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import { recoverMarkedProgressComment } from "../github/recoverPrSurfaceMutation.js";
import { enqueueCiProjectionIfDue, loadRenderableHeadCi } from "./ciProjection.js";
import { summaryCommentVerdictMeta } from "./ownCheckReconcile.js";
import { getSummaryCommentGithubId, recordPublishStep, shouldSkipWork } from "./repository.js";
import type { AgentWorkItem } from "./types.js";
import {
  operationIntentMarker,
  reviewSummaryOperationKey,
  withOperationIntent,
} from "./withOperationIntent.js";

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
    };

/** Auto-review docs-only path: publish lightweight summary or skip when work is cancelled. */
export async function tryLightweightAutoReviewCompletion(
  pool: Pool,
  params: {
    item: AgentWorkItem;
    reviewLens: ReviewMode;
    prSurface: PrSurface;
    preflight: ReviewPreflightMetadata;
    model: string;
    leaseEpoch: number | null;
    boss?: PgBoss;
  },
): Promise<LightweightAutoReviewResult> {
  if (params.item.source !== "auto") return { handled: false };

  const trivial = evaluateTrivialChangeExemption({
    files: params.preflight.files,
    truncated: params.preflight.truncated,
  });
  if (!trivial.exempt) return { handled: false };

  if (await shouldSkipWork(pool, params.item)) {
    return { handled: true, published: false, reason: "skipped" };
  }

  const metricsSnapshot = snapshotReviewRunMetrics();
  const renderedCi = await loadRenderableHeadCi(
    pool,
    params.item.owner,
    params.item.repo,
    params.item.headSha,
  );
  const body = renderLightweightReviewCompletion(
    {
      headSha: params.item.headSha,
      durationMs: resolveReviewWallClockMs({
        metricsStartedAtMs: metricsSnapshot?.startedAtMs,
        endedAtMs: Date.now(),
      }),
      model: params.model,
    },
    { ciSummary: renderedCi.summary, ciVersion: renderedCi.version },
  );
  const sentinel = REVIEW_SUMMARY_SENTINEL;
  const operationKey = reviewSummaryOperationKey(params.item.resourceKey, params.reviewLens);
  const operationMarker = operationIntentMarker(operationKey, params.item.id);
  const bodyWithMarker = `${body}\n${operationMarker}`;
  const storedId = await getSummaryCommentGithubId(
    pool,
    params.item.resourceKey,
    params.reviewLens,
  );
  const knownExisting = await params.prSurface.resolveProgressComment(sentinel, storedId);
  const summary = await withOperationIntent<{
    readonly id: number;
    readonly updated: boolean;
  }>({
    client: pool,
    workItemId: params.item.id,
    operationKey,
    mutationKind: "github.review_summary_comment",
    leaseEpoch: params.leaseEpoch,
    detail: {
      step: "summary_comment",
      resourceKey: params.item.resourceKey,
      reviewLens: params.reviewLens,
      operationMarker,
    },
    recover: () =>
      recoverMarkedProgressComment(params.prSurface, {
        operationMarker,
        sentinel,
        knownExistingId: knownExisting?.id,
      }),
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    // Terminal revision 7 fences a late ack stub (revision 0) from overwriting this body.
    mutate: () =>
      upsertSummaryCommentWithCreationClaim({
        pool,
        workItemId: params.item.id,
        leaseEpoch: params.leaseEpoch,
        resourceKey: params.item.resourceKey,
        reviewLens: params.reviewLens,
        prSurface: params.prSurface,
        body: bodyWithMarker,
        sentinel,
        hintCommentId: knownExisting?.id ?? storedId,
        progressRevision: 7,
        ciHeadSha: params.item.headSha,
        ciVersion: renderedCi.version,
      }),
  });
  await enqueueCiProjectionIfDue({
    boss: params.boss,
    pool,
    installationId: params.item.installationId,
    owner: params.item.owner,
    repo: params.item.repo,
    headSha: params.item.headSha,
    renderedVersion: renderedCi.version,
  });
  await recordPublishStep(pool, {
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    reviewLens: params.reviewLens,
    step: "summary_comment",
    githubId: summary.id,
    detail: {
      lightweightCompletion: true,
      trivialReason: "docs_only",
      ...summaryCommentVerdictMeta({ kind: "published", findings: [] }),
    },
    leaseEpoch: params.leaseEpoch,
  });
  return { handled: true, published: true, summaryId: summary.id };
}
