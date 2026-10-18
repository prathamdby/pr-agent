import { decodeProgressComment } from "../github/prSurfaceResults.ts";
import { createPublishContext } from "./publishOnce.ts";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { evaluateTrivialChangeExemption } from "../review/run/reviewChangeGate.ts";
import type { ReviewPreflightMetadata } from "../review/placement/reviewPreflightFiles.ts";
import { createReviewSummaryComment } from "../review/publish/reviewSummaryComment.ts";
import { renderLightweightReviewCompletion } from "../review/run/reviewRender.ts";
import { resolveReviewWallClockMs } from "../review/run/reviewRunFooter.ts";
import { snapshotReviewRunMetrics } from "../review/run/reviewRunMetrics.ts";
import { REVIEW_SUMMARY_SENTINEL, type ReviewMode } from "../review/reviewSchema.ts";
import type { PrSurface } from "../github/prSurface.ts";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.ts";
import { recoverMarkedProgressComment } from "../github/recoverPrSurfaceMutation.ts";
import { loadRenderableHeadCi, requestHeadCiProjection } from "./ciProjection.ts";
import { summaryCommentVerdictMeta } from "./reviewVerdict.ts";
import { getSummaryCommentGithubId } from "./publishRecordRepository.ts";
import { shouldSkipWork } from "./workItemStateRepository.ts";
import type { AgentWorkItem } from "./types.ts";
import { operationIntentMarker, reviewSummaryOperationKey, publishOnce } from "./publishOnce.ts";
import { fenceForEpoch } from "./writeFence.ts";
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
    params.item.installationId,
  );
  const findingView = buildFindingView(
    await loadFindingInventoryOrUnavailable(params.prSurface, {
      renames: new Map(),
      deletedPaths: new Set(),
    }),
    { kind: "not_reviewed" },
  );
  const check = findingCheck(findingView);
  const footer = {
    headSha: params.item.headSha,
    durationMs: resolveReviewWallClockMs({
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
  const storedId = await getSummaryCommentGithubId(
    pool,
    params.item.resourceKey,
    params.reviewLens,
  );
  const knownExisting = await params.prSurface.resolveProgressComment(sentinel, storedId);
  const summary = await publishOnce<{
    readonly id: number;
    readonly updated: boolean;
  }>({
    decodeResult: decodeProgressComment,
    fence: fenceForEpoch(params.leaseEpoch),
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
    mutate: () =>
      createReviewSummaryComment({
        prSurface: params.prSurface,
        reviewLens: params.reviewLens,
        coordination: {
          pool,
          resourceKey: params.item.resourceKey,
          workItemId: params.item.id,
          leaseEpoch: params.leaseEpoch,
        },
      }).conclude({
        body: bodyWithMarker,
        hintCommentId: knownExisting?.id ?? storedId,
        ciHeadSha: params.item.headSha,
        ciVersion: renderedCi.version,
      }),
  });
  await requestHeadCiProjection(
    params.boss,
    {
      installationId: params.item.installationId,
      owner: params.item.owner,
      repo: params.item.repo,
      headSha: params.item.headSha,
    },
    { kind: "when_due", pool, renderedVersion: renderedCi.version },
  );
  await createPublishContext(pool, {
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    reviewLens: params.reviewLens,
    step: "summary_comment",
    githubId: summary.id,
    detail: {
      lightweightCompletion: true,
      trivialReason: "docs_only",
      ...summaryCommentVerdictMeta({ kind: "published", conclusion: check.conclusion }),
    },
    leaseEpoch: params.leaseEpoch,
  }).record();
  return { handled: true, published: true, summaryId: summary.id, check };
}
