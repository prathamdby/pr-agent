import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logInfo, logWarn, logDebug } from "../../evlog.js";
import type { PrSurface } from "../../github/prSurface.js";
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
  type ReviewPayload,
  type ReviewPublishContext,
} from "../reviewSchema.js";
import { parseToolInput } from "../../agent/tools/parseToolInput.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type { AcceptedPlacement } from "../orchestrator/orchestratorTypes.js";
import type { CheckoutCoverage } from "../../prWorkspace/localPrWorkspace.js";
import type { EvidenceLedger } from "../findings/evidenceLedger.js";

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
const SUBMIT_REVIEW_PARAMETERS = toJsonSchema(SUBMIT_REVIEW_SCHEMA, {
  errorMode: "ignore",
}) as PiTool["parameters"];

type SubmitReviewToolParams = Parameters<typeof buildSubmitReviewTool>[0];
type SubmitReviewDuplicate = { readonly ok: true; readonly duplicate: true };

function submitReviewReadyResult(
  state: SubmitReviewState,
  mode: AnyReviewLens,
  ctx: ReviewPublishContext,
): SubmitReviewDuplicate | null {
  if (state.published) {
    logDebug("review_submit_duplicate_ignored", {
      mode,
      owner: ctx.owner,
      repo: ctx.repo,
      pr: ctx.prNumber,
    });
    return { ok: true, duplicate: true };
  }

  if (state.publishCallsExhausted) {
    logDebug("review_submit_budget_exhausted_ignored", {
      mode,
      owner: ctx.owner,
      repo: ctx.repo,
      pr: ctx.prNumber,
    });
    throw new AppError({
      code: "review.publish_exhausted",
      message: PUBLISH_BUDGET_EXHAUSTED_MESSAGE,
    });
  }
  return null;
}

function assertDiffCacheReadyForSubmit(
  cachedDiffIndex: CachedPrDiffIndex | undefined,
  enforceDiffAndAnchors: boolean,
): void {
  if (cachedDiffIndex && !cachedDiffIndex.listPullRequestFilesIngested && enforceDiffAndAnchors) {
    recordReviewMetric({ kind: "diff_cache_empty_at_submit" });
    throw new AppError({
      code: "review.diff_cache_required",
      message: REVIEW_DIFF_CACHE_REQUIRED_MESSAGE,
    });
  }
}

function validateSubmitReviewPayload(
  args: Record<string, unknown>,
  state: SubmitReviewState,
  mode: AnyReviewLens,
  ctx: ReviewPublishContext,
): ReviewPayload {
  // Validate-then-repair: an already-valid payload is never rewritten by
  // the domain coercions below; they run only after a validation failure,
  // followed by the generic four-repair pass at the failing paths.
  const direct = v.safeParse(SUBMIT_REVIEW_SCHEMA, args);
  if (direct.success) {
    state.lastValidationError = null;
    recordReviewMetric({ kind: "submit_validated", coercions: [] });
    return direct.output;
  }
  const coercedResult = coerceReviewPayloadInput(args);
  if (coercedResult.coerced) {
    logDebug("review_payload_coerced", {
      mode,
      owner: ctx.owner,
      repo: ctx.repo,
      coercions: coercedResult.coercions,
    });
  }
  const parsed = parseToolInput(SUBMIT_REVIEW_SCHEMA, coercedResult.value, {
    toolName: "submitReview",
  });
  if (!parsed.ok) {
    const formatted = formatReviewValidationError(parsed.issues);
    state.lastValidationError = formatted.message;
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
  state.lastValidationError = null;
  recordReviewMetric({ kind: "submit_validated", coercions: coercedResult.coercions });
  return parsed.value;
}

function prepareValidatedSubmitReview(params: {
  readonly output: ReviewPayload;
  readonly state: SubmitReviewState;
  readonly mode: AnyReviewLens;
  readonly enforceDiffAndAnchors: boolean;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly severityFloor?: number;
  readonly evidenceLedger?: EvidenceLedger;
  readonly checkoutCoverage?: CheckoutCoverage;
  readonly isPathInCheckout?: (path: string) => boolean;
  readonly headSha: string;
}): { readonly payload: ReviewPayload; readonly dedupedCount: number } {
  const prepared = prepareReviewPayloadForPublish({
    payload: params.output,
    reviewMinConfidence: REVIEW_MIN_CONFIDENCE,
    severityFloor: params.severityFloor,
    cachedDiffIndex: params.cachedDiffIndex,
    enforceInlineAnchorValidation: params.enforceDiffAndAnchors,
    evidenceLedger: params.evidenceLedger,
    headSha: params.headSha,
    checkoutCoverage: params.checkoutCoverage,
    isPathInCheckout: params.isPathInCheckout,
  });
  if (!prepared.ok) {
    params.state.lastValidationError = prepared.error;
    if (prepared.anchorFailures.length > 0) {
      recordReviewMetric({
        kind: "anchor_failure",
        count: prepared.anchorFailures.length,
        files: prepared.anchorFailures.map((failure) => failure.file),
      });
    }
    logWarn("review_payload_semantic_validation_failed", {
      mode: params.mode,
      message: prepared.error.slice(0, 200),
      anchorFailureCount: prepared.anchorFailures.length,
    });
    throw new AppError({
      code: "review.payload_semantic_validation_failed",
      message: prepared.error,
    });
  }
  return prepared.prepared;
}

async function abortSubmitReviewIfSuperseded(params: SubmitReviewToolParams): Promise<void> {
  if (!params.shouldAbortPublish) return;
  const mode = params.mode ?? "review";
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
  if (!shouldAbort) return;
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

async function publishValidatedSubmitReview(input: {
  readonly params: SubmitReviewToolParams;
  readonly mode: AnyReviewLens;
  readonly output: ReviewPayload;
  readonly preparedPayload: ReviewPayload;
  readonly dedupedFindingCount: number;
}): Promise<
  | { readonly ok: true; readonly findingsCount: number; readonly severities: string[] }
  | { readonly ok: false; readonly publishSuperseded: true }
> {
  const { params, mode, output } = input;
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
      prSurface: params.prSurface,
      mode,
      cfg: params.cfg,
      ...params.ctx,
      payload: input.preparedPayload,
      dedupedFindingCount: input.dedupedFindingCount,
      publishState: params.state,
      cachedDiffIndex: params.cachedDiffIndex,
      shouldLinkToSummary: params.shouldLinkToSummary,
      progressCommentIdHint: params.progressCommentIdHint,
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
  const severities = output.findings.map((finding) => finding.severity);
  recordReviewMetric({
    kind: "published",
    findingsCount: output.findings.length,
    severities,
  });
  logInfo("review_published", {
    mode,
    owner: params.ctx.owner,
    repo: params.ctx.repo,
    pr: params.ctx.prNumber,
    findingsCount: output.findings.length,
  });
  return { ok: true, findingsCount: output.findings.length, severities };
}

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
  prSurface: PrSurface;
  ctx: ReviewPublishContext;
  mode?: AnyReviewLens;
  state: SubmitReviewState;
  cachedDiffIndex?: CachedPrDiffIndex;
  canEnforceDiffCacheBeforeSubmit?: () => boolean;
  shouldLinkToSummary?: boolean;
  progressCommentIdHint?: number | null;
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
  evidenceLedger?: EvidenceLedger;
  checkoutCoverage?: CheckoutCoverage;
  isPathInCheckout?: (path: string) => boolean;
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
    const alreadyReady = submitReviewReadyResult(params.state, mode, params.ctx);
    if (alreadyReady) return alreadyReady;
    const enforceDiffAndAnchors = params.canEnforceDiffCacheBeforeSubmit?.() ?? true;
    assertDiffCacheReadyForSubmit(params.cachedDiffIndex, enforceDiffAndAnchors);
    const output = validateSubmitReviewPayload(args, params.state, mode, params.ctx);
    const prepared = prepareValidatedSubmitReview({
      output,
      state: params.state,
      mode,
      enforceDiffAndAnchors,
      cachedDiffIndex: params.cachedDiffIndex,
      severityFloor: params.severityFloor,
      evidenceLedger: params.evidenceLedger,
      checkoutCoverage: params.checkoutCoverage,
      isPathInCheckout: params.isPathInCheckout,
      headSha: params.ctx.headSha,
    });
    await abortSubmitReviewIfSuperseded(params);
    return publishValidatedSubmitReview({
      params,
      mode,
      output,
      preparedPayload: prepared.payload,
      dedupedFindingCount: prepared.dedupedCount,
    });
  };

  return { piTool, executor };
}
