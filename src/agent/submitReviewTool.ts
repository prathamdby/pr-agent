import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { logInfo, logWarn, logDebug } from "../evlog.js";
import { publishReview } from "./publishReview.js";
import {
  coerceReviewPayloadInput,
  formatReviewValidationError,
  reviewPayloadSchema,
  REVIEW_PAYLOAD_MINIMAL_EXAMPLE,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
  REVIEW_SUMMARY_SENTINEL,
  type ReviewMode,
  type ReviewPublishContext,
} from "./reviewSchema.js";

const DELIVERY_TOOL_NAMES = new Set(["createPullRequestReview", "addPullRequestComment"]);

export function filterReviewAgentTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => !DELIVERY_TOOL_NAMES.has(t.name));
}

export function filterReviewAgentExecutors(
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const out: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  for (const [name, fn] of Object.entries(executors)) {
    if (!DELIVERY_TOOL_NAMES.has(name)) out[name] = fn;
  }
  return out;
}

export type SubmitReviewState = {
  published: boolean;
  inlinePublished: boolean;
  lastValidationError: string | null;
};

export function buildSubmitReviewTool(params: {
  cfg: Config;
  token: string;
  ctx: ReviewPublishContext;
  mode?: ReviewMode;
  state: SubmitReviewState;
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
  recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { githubId?: string | number; meta?: Record<string, unknown> },
  ) => Promise<void>;
  shouldAbortPublish?: () => Promise<boolean>;
}): {
  piTool: PiTool;
  executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
  const submitSchema = reviewPayloadSchema;
  const mode = params.mode ?? "review";

  const summarySentinel =
    mode === "review-security" ? SECURITY_REVIEW_SUMMARY_SENTINEL : REVIEW_SUMMARY_SENTINEL;
  const piTool: PiTool = {
    name: "submitReview",
    description: [
      "Submit the completed structured review exactly once.",
      "Pass a ReviewPayload object matching the schema.",
      `This publishes inline review threads and a PR conversation summary starting with \`${summarySentinel}\`.`,
      "Do not call createPullRequestReview or addPullRequestComment.",
      "Fields: prCharacter (string), findings (array, max 8), estimatedEffort (integer 1-5), relevantTests (yes|no|partial), securityConcerns (string|null), followUps (string array, max 5).",
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

    const { value: coercedArgs, coerced } = coerceReviewPayloadInput(args);
    if (coerced) {
      logDebug("review_payload_coerced", { mode, owner: params.ctx.owner, repo: params.ctx.repo });
    }

    const parsed = submitSchema.safeParse(coercedArgs);
    if (!parsed.success) {
      const message = formatReviewValidationError(parsed.error);
      params.state.lastValidationError = message;
      logWarn("review_payload_validation_failed", {
        mode,
        message: message.slice(0, 200),
      });
      throw new Error(message);
    }

    params.state.lastValidationError = null;
    if (params.shouldAbortPublish && (await params.shouldAbortPublish())) {
      logInfo("review_submit_skipped_superseded", {
        mode,
        owner: params.ctx.owner,
        repo: params.ctx.repo,
        pr: params.ctx.prNumber,
      });
      throw new Error("Review publish skipped: work superseded or cancelled");
    }
    await publishReview({
      token: params.token,
      mode,
      cfg: params.cfg,
      ...params.ctx,
      payload: parsed.data,
      publishState: params.state,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
      recordPublishStep: params.recordPublishStep,
    });
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
