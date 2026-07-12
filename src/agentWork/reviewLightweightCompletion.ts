import type { Pool } from "pg";
import { evaluateTrivialChangeExemption } from "../review/run/reviewChangeGate.js";
import type { ReviewPreflightMetadata } from "../review/placement/reviewPreflightFiles.js";
import { renderLightweightReviewCompletion } from "../review/run/reviewRender.js";
import type { ReviewMode } from "../review/reviewSchema.js";
import {
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../github/reviewPublish.js";
import { getSummaryCommentGithubId, recordPublishStep, shouldSkipWork } from "./repository.js";
import type { AgentWorkItem } from "./types.js";
import { REVIEW_SUMMARY_SENTINEL } from "../settings/index.js";

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

  const body = renderLightweightReviewCompletion();
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
