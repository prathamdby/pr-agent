import type { Pool } from "pg";
import { evaluateTrivialChangeExemption } from "../agent/reviewChangeGate.js";
import type { ReviewPreflightMetadata } from "../agent/reviewPreflightFiles.js";
import { renderLightweightReviewCompletion } from "../agent/reviewRender.js";
import { reviewSummarySentinelForMode, type ReviewMode } from "../agent/reviewSchema.js";
import { upsertReviewSummaryComment } from "../github/reviewPublish.js";
import { recordPublishStep, shouldSkipWork } from "./repository.js";
import type { AgentWorkItem } from "./types.js";

/** Auto-review docs-only path: publish lightweight summary or skip when work is cancelled. */
export async function tryLightweightAutoReviewCompletion(
  pool: Pool,
  params: {
    item: AgentWorkItem;
    reviewLens: ReviewMode;
    token: string;
    preflight: ReviewPreflightMetadata;
  },
): Promise<boolean> {
  if (params.item.source !== "auto") return false;

  const trivial = evaluateTrivialChangeExemption({
    files: params.preflight.files,
    truncated: params.preflight.truncated,
  });
  if (!trivial.exempt) return false;

  if (await shouldSkipWork(pool, params.item)) return true;

  const body = renderLightweightReviewCompletion(params.reviewLens);
  const summary = await upsertReviewSummaryComment(
    params.token,
    params.item.owner,
    params.item.repo,
    params.item.prNumber,
    body,
    reviewSummarySentinelForMode(params.reviewLens),
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
  return true;
}
