import type { Pool } from "pg";
import { evaluateTrivialChangeExemption } from "../review/run/reviewChangeGate.js";
import type { ReviewPreflightMetadata } from "../review/placement/reviewPreflightFiles.js";
import { renderLightweightReviewCompletion } from "../review/run/reviewRender.js";
import { resolveReviewWallClockMs } from "../review/run/reviewRunFooter.js";
import { snapshotReviewRunMetrics } from "../review/run/reviewRunMetrics.js";
import { REVIEW_SUMMARY_SENTINEL, type ReviewMode } from "../review/reviewSchema.js";
import {
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../github/reviewPublish.js";
import {
  getProgressStubPostedAtMs,
  getSummaryCommentGithubId,
  recordPublishStep,
  shouldSkipWork,
} from "./repository.js";
import type { AgentWorkItem } from "./types.js";

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
    token: string;
    tokenExpiresAtTs?: number;
    preflight: ReviewPreflightMetadata;
    model: string;
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
  const stubPostedAtMs = await getProgressStubPostedAtMs(
    pool,
    params.item.resourceKey,
    params.reviewLens,
  );
  const body = renderLightweightReviewCompletion({
    headSha: params.item.headSha,
    durationMs: resolveReviewWallClockMs({
      stubPostedAtMs,
      metricsStartedAtMs: metricsSnapshot?.startedAtMs,
      endedAtMs: Date.now(),
    }),
    model: params.model,
  });
  const sentinel = REVIEW_SUMMARY_SENTINEL;
  const storedId = await getSummaryCommentGithubId(
    pool,
    params.item.resourceKey,
    params.reviewLens,
  );
  const verified =
    storedId != null
      ? await resolveVerifiedSummaryCommentRef(
          params.token,
          params.item.owner,
          params.item.repo,
          params.item.prNumber,
          sentinel,
          storedId,
          params.tokenExpiresAtTs,
        )
      : null;
  const knownExisting = verified ? { id: verified.id, url: verified.url } : undefined;
  const summary = await upsertReviewSummaryComment(
    params.token,
    params.item.owner,
    params.item.repo,
    params.item.prNumber,
    body,
    sentinel,
    knownExisting,
    params.tokenExpiresAtTs,
  );
  await recordPublishStep(pool, {
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    reviewLens: params.reviewLens,
    step: "summary_comment",
    githubId: summary.id,
    detail: {
      lightweightCompletion: true,
      trivialReason: "docs_only",
    },
  });
  return { handled: true, published: true, summaryId: summary.id };
}
