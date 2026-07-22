import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logInfo, logWarn, logDebug } from "../../evlog.js";
import { publishReview } from "./publishReview.js";
import { createAgentCiSummaryAuthor } from "../ci/authorCiSummary.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import { prepareReviewPayloadForPublish } from "../findings/findingPipeline.js";
import {
  PUBLISH_BUDGET_EXHAUSTED_MESSAGE,
  REVIEW_DIFF_CACHE_REQUIRED_MESSAGE,
  MAX_REVIEW_PUBLISH_CALLS,
  REVIEW_MIN_CONFIDENCE,
} from "../../settings/index.js";
import { recordReviewMetric } from "../run/reviewRunMetrics.js";
import {
  coerceReviewPayloadInput,
  createReviewPayloadSchema,
  formatReviewValidationError,
  REVIEW_SUMMARY_SENTINEL,
  type ReviewPublishContext,
} from "../reviewSchema.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type { AcceptedPlacement } from "../orchestrator/orchestratorTypes.js";

export type SubmitReviewState = {
  published: boolean;
  inlineReviewIds: number[];
  threadCallCount: number;
  lastValidationError: string | null;
  publishCallCount: number;
  publishCallsExhausted: boolean;
  /** Set only by submitReview when publish is skipped (superseded, cancelled, or abort-check failed). */
  publishSuperseded: boolean;
};

const SUBMIT_REVIEW_SCHEMA = createReviewPayloadSchema();
const SUBMIT_REVIEW_PARAMETERS = z.toJSONSchema(SUBMIT_REVIEW_SCHEMA, {
  unrepresentable: "any",
}) as PiTool["parameters"];

export function createSubmitReviewState(initial?: {
  readonly published?: boolean;
  readonly inlineReviewIds?: readonly number[];
  readonly threadCallCount?: number;
}): SubmitReviewState {
  return {
    published: initial?.published ?? false,
    inlineReviewIds: [...(initial?.inlineReviewIds ?? [])],
    threadCallCount: initial?.threadCallCount ?? 0,
    lastValidationError: null,
    publishCallCount: 0,
    publishCallsExhausted: false,
    publishSuperseded: false,
  };
}

export function buildSubmitReviewTool(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs?: number;
  getToken?: () => string;
  getTokenExpiresAtTs?: () => number;
  ctx: ReviewPublishContext;
  mode?: AnyReviewLens;
  state: SubmitReviewState;
  cachedDiffIndex?: CachedPrDiffIndex;
  canEnforceDiffCacheBeforeSubmit?: () => boolean;
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
  recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { githubId?: string | number; meta?: Record<string, unknown> },
  ) => Promise<void>;
  shouldAbortPublish?: () => Promise<boolean>;
  storedInlineFingerprints?: readonly string[];
  workItemId?: string;
  resumedPlacements?: readonly AcceptedPlacement[];
  publishAbortState?: { staleHead?: boolean };
  severityFloor?: number;
}): {
  piTool: PiTool;
  executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
  const mode = params.mode ?? "review";

  const summarySentinel = REVIEW_SUMMARY_SENTINEL;
  const piTool: PiTool = {
    name: "submitReview",
    description: [
      "Submit the completed structured review exactly once.",
      "Pass a ReviewPayload object matching the tool schema; required top-level fields are enforced by validation.",
      `Publishes inline review threads and a PR conversation summary starting with \`${summarySentinel}\`.`,
      "Each finding: severity P0|P1|P2|P3, file, startLine, endLine, title, detail; fixPrompt required for every finding including P3.",
    ].join(" "),
    parameters: SUBMIT_REVIEW_PARAMETERS,
  };

  const executor = async (args: Record<string, unknown>) => {
    if (params.state.published) {
      logDebug("review_submit_duplicate_ignored", {
        mode,
        owner: params.ctx.owner,
        repo: params.ctx.repo,
        pr: params.ctx.prNumber,
      });
      return { ok: true, duplicate: true };
    }

    if (params.state.publishCallsExhausted) {
      logDebug("review_submit_budget_exhausted_ignored", {
        mode,
        owner: params.ctx.owner,
        repo: params.ctx.repo,
        pr: params.ctx.prNumber,
      });
      throw new AppError({
        code: "review.publish_exhausted",
        message: PUBLISH_BUDGET_EXHAUSTED_MESSAGE,
      });
    }

    const enforceDiffAndAnchors = params.canEnforceDiffCacheBeforeSubmit?.() ?? true;

    if (
      params.cachedDiffIndex &&
      !params.cachedDiffIndex.listPullRequestFilesIngested &&
      enforceDiffAndAnchors
    ) {
      recordReviewMetric({ kind: "diff_cache_empty_at_submit" });
      throw new AppError({
        code: "review.diff_cache_required",
        message: REVIEW_DIFF_CACHE_REQUIRED_MESSAGE,
      });
    }

    const { value: coercedArgs, coerced, coercions } = coerceReviewPayloadInput(args);
    if (coerced) {
      logDebug("review_payload_coerced", {
        mode,
        owner: params.ctx.owner,
        repo: params.ctx.repo,
        coercions,
      });
    }

    const parsed = SUBMIT_REVIEW_SCHEMA.safeParse(coercedArgs);
    if (!parsed.success) {
      const formatted = formatReviewValidationError(parsed.error);
      params.state.lastValidationError = formatted.message;
      recordReviewMetric({
        kind: "validation_failed",
        failureKind: formatted.failureKind,
        paths: formatted.paths,
      });
      logWarn("review_payload_validation_failed", {
        mode,
        failureKind: formatted.failureKind,
        message: formatted.message.slice(0, 200),
      });
      throw new AppError({
        code: "review.payload_validation_failed",
        message: formatted.message,
      });
    }

    params.state.lastValidationError = null;
    recordReviewMetric({ kind: "submit_validated", coercions });

    const prepared = prepareReviewPayloadForPublish({
      payload: parsed.data,
      reviewMinConfidence: REVIEW_MIN_CONFIDENCE,
      severityFloor: params.severityFloor,
      cachedDiffIndex: params.cachedDiffIndex,
      enforceInlineAnchorValidation: enforceDiffAndAnchors,
    });
    if (!prepared.ok) {
      params.state.lastValidationError = prepared.error;
      if (prepared.anchorFailures.length > 0) {
        recordReviewMetric({
          kind: "anchor_failure",
          count: prepared.anchorFailures.length,
          files: prepared.anchorFailures.map((f) => f.file),
        });
      }
      logWarn("review_payload_semantic_validation_failed", {
        mode,
        message: prepared.error.slice(0, 200),
        anchorFailureCount: prepared.anchorFailures.length,
      });
      throw new AppError({
        code: "review.payload_semantic_validation_failed",
        message: prepared.error,
      });
    }

    if (params.shouldAbortPublish) {
      let shouldAbort = false;
      try {
        shouldAbort = await params.shouldAbortPublish();
      } catch (e) {
        logWarn("review_submit_abort_check_failed", {
          mode,
          owner: params.ctx.owner,
          repo: params.ctx.repo,
          pr: params.ctx.prNumber,
          message: e instanceof Error ? e.message : String(e),
        });
        shouldAbort = true;
      }
      if (shouldAbort) {
        logInfo("review_submit_skipped_superseded", {
          mode,
          owner: params.ctx.owner,
          repo: params.ctx.repo,
          pr: params.ctx.prNumber,
        });
        params.state.publishSuperseded = true;
        throw new AppError({
          code: "review.publish_superseded",
          message: "Review publish skipped: work superseded or cancelled",
        });
      }
    }

    if (params.state.publishCallCount >= MAX_REVIEW_PUBLISH_CALLS) {
      params.state.publishCallsExhausted = true;
      throw new AppError({
        code: "review.publish_exhausted",
        message: PUBLISH_BUDGET_EXHAUSTED_MESSAGE,
      });
    }

    params.state.publishCallCount += 1;
    recordReviewMetric({ kind: "publish_attempted" });

    try {
      await publishReview({
        token: params.getToken?.() ?? params.token,
        getToken: params.getToken,
        tokenExpiresAtTs: params.getTokenExpiresAtTs?.() ?? params.tokenExpiresAtTs,
        getTokenExpiresAtTs: params.getTokenExpiresAtTs,
        mode,
        cfg: params.cfg,
        ...params.ctx,
        payload: prepared.prepared.payload,
        dedupedFindingCount: prepared.prepared.dedupedCount,
        publishState: params.state,
        cachedDiffIndex: params.cachedDiffIndex,
        shouldLinkToSummary: params.shouldLinkToSummary,
        summaryCommentIdHint: params.summaryCommentIdHint,
        recordPublishStep: params.recordPublishStep,
        storedInlineFingerprints: params.storedInlineFingerprints,
        workItemId: params.workItemId,
        resumedPlacements: params.resumedPlacements,
        shouldAbortPublish: params.shouldAbortPublish,
        publishAbortState: params.publishAbortState,
        staleReview: params.publishAbortState?.staleHead === true,
        ciSummaryAuthor: createAgentCiSummaryAuthor(params.cfg),
      });
    } catch (e) {
      logWarn("review_publish_failed", {
        mode,
        owner: params.ctx.owner,
        repo: params.ctx.repo,
        pr: params.ctx.prNumber,
        message: e instanceof Error ? e.message : String(e),
        publishCallCount: params.state.publishCallCount,
      });
      if (params.state.publishCallCount >= MAX_REVIEW_PUBLISH_CALLS) {
        params.state.publishCallsExhausted = true;
      }
      throw new AppError({
        code: params.state.publishCallsExhausted
          ? "review.publish_exhausted"
          : "review.publish_failed",
        message: params.state.publishCallsExhausted
          ? PUBLISH_BUDGET_EXHAUSTED_MESSAGE
          : "Review publish failed. Retry submitReview with a valid ReviewPayload if publish budget remains.",
        cause: e,
      });
    }

    if (params.state.publishSuperseded) {
      return { ok: false, publishSuperseded: true };
    }

    params.state.published = true;
    const severities = parsed.data.findings.map((f) => f.severity);
    recordReviewMetric({
      kind: "published",
      findingsCount: parsed.data.findings.length,
      severities,
    });
    logInfo("review_published", {
      mode,
      owner: params.ctx.owner,
      repo: params.ctx.repo,
      pr: params.ctx.prNumber,
      findingsCount: parsed.data.findings.length,
    });
    return { ok: true, findingsCount: parsed.data.findings.length, severities };
  };

  return { piTool, executor };
}
