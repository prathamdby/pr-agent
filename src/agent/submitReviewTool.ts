import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { logInfo, logWarn, logDebug } from "../evlog.js";
import { publishReview } from "./publishReview.js";
import type { CachedPrDiffIndex } from "./reviewLocationValidation.js";
import { prepareReviewPayloadForPublish } from "./reviewPrePublish.js";
import { PUBLISH_BUDGET_EXHAUSTED_MESSAGE } from "../settings/index.js";
import {
  coerceReviewPayloadInput,
  createReviewPayloadSchema,
  formatReviewValidationError,
  REVIEW_PAYLOAD_MINIMAL_EXAMPLE,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
  REVIEW_SUMMARY_SENTINEL,
  type ReviewMode,
  type ReviewPublishContext,
} from "./reviewSchema.js";

export { PUBLISH_BUDGET_EXHAUSTED_MESSAGE } from "../settings/index.js";

export type SubmitReviewState = {
  published: boolean;
  inlinePublished: boolean;
  inlineReviewId: number | null;
  lastValidationError: string | null;
  publishCallCount: number;
  publishCallsExhausted: boolean;
};

export function createSubmitReviewState(
  initial?: Partial<Pick<SubmitReviewState, "published" | "inlinePublished" | "inlineReviewId">>,
): SubmitReviewState {
  return {
    published: initial?.published ?? false,
    inlinePublished: initial?.inlinePublished ?? false,
    inlineReviewId: initial?.inlineReviewId ?? null,
    lastValidationError: null,
    publishCallCount: 0,
    publishCallsExhausted: false,
  };
}

export function buildSubmitReviewTool(params: {
  cfg: Config;
  token: string;
  getToken?: () => string;
  ctx: ReviewPublishContext;
  mode?: ReviewMode;
  state: SubmitReviewState;
  cachedDiffIndex?: CachedPrDiffIndex;
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
  recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { githubId?: string | number; meta?: Record<string, unknown> },
  ) => Promise<void>;
  shouldAbortPublish?: () => Promise<boolean>;
  storedInlineFingerprints?: readonly string[];
}): {
  piTool: PiTool;
  executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
  const submitSchema = createReviewPayloadSchema(params.cfg.maxReviewFindings);
  const mode = params.mode ?? "review";
  const maxFindings = params.cfg.maxReviewFindings;

  const summarySentinel =
    mode === "review-security" ? SECURITY_REVIEW_SUMMARY_SENTINEL : REVIEW_SUMMARY_SENTINEL;
  const piTool: PiTool = {
    name: "submitReview",
    description: [
      "Submit the completed structured review exactly once.",
      "Pass a ReviewPayload object matching the schema.",
      `This publishes inline review threads and a PR conversation summary starting with \`${summarySentinel}\`.`,
      `Fields: prCharacter (string), findings (array, max ${maxFindings}), estimatedEffort (integer 1-5), relevantTests (yes|no|partial), securityConcerns (string|null), followUps (string array, max 5).`,
      "Each finding: severity P0|P1|P2|P3, file, startLine, endLine, title, detail; fixPrompt required for P0/P1/P2.",
      `Minimal valid example: ${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE)}`,
    ].join(" "),
    parameters: z.toJSONSchema(submitSchema, { unrepresentable: "any" }) as PiTool["parameters"],
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
      throw new Error(PUBLISH_BUDGET_EXHAUSTED_MESSAGE);
    }

    const { value: coercedArgs, coerced } = coerceReviewPayloadInput(args);
    if (coerced) {
      logDebug("review_payload_coerced", { mode, owner: params.ctx.owner, repo: params.ctx.repo });
    }

    const parsed = submitSchema.safeParse(coercedArgs);
    if (!parsed.success) {
      const message = formatReviewValidationError(parsed.error, maxFindings);
      params.state.lastValidationError = message;
      logWarn("review_payload_validation_failed", {
        mode,
        message: message.slice(0, 200),
      });
      throw new Error(message);
    }

    params.state.lastValidationError = null;

    const prepared = prepareReviewPayloadForPublish({
      payload: parsed.data,
      mode,
      cachedDiffIndex: params.cachedDiffIndex,
    });
    if (!prepared.ok) {
      params.state.lastValidationError = prepared.error;
      logWarn("review_payload_semantic_validation_failed", {
        mode,
        message: prepared.error.slice(0, 200),
      });
      throw new Error(prepared.error);
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
        throw new Error("Review publish skipped: work superseded or cancelled");
      }
    }

    if (params.state.publishCallCount >= params.cfg.maxReviewPublishCalls) {
      params.state.publishCallsExhausted = true;
      throw new Error(PUBLISH_BUDGET_EXHAUSTED_MESSAGE);
    }

    params.state.publishCallCount += 1;

    try {
      await publishReview({
        token: params.getToken?.() ?? params.token,
        mode,
        cfg: params.cfg,
        ...params.ctx,
        payload: prepared.prepared.payload,
        publishState: params.state,
        cachedDiffIndex: params.cachedDiffIndex,
        shouldLinkToSummary: params.shouldLinkToSummary,
        summaryCommentIdHint: params.summaryCommentIdHint,
        recordPublishStep: params.recordPublishStep,
        storedInlineFingerprints: params.storedInlineFingerprints,
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
      if (params.state.publishCallCount >= params.cfg.maxReviewPublishCalls) {
        params.state.publishCallsExhausted = true;
      }
      throw new Error(
        params.state.publishCallsExhausted
          ? PUBLISH_BUDGET_EXHAUSTED_MESSAGE
          : "Review publish failed. Retry submitReview with a valid ReviewPayload if publish budget remains.",
        { cause: e },
      );
    }

    params.state.published = true;
    const severities = parsed.data.findings.map((f) => f.severity);
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
