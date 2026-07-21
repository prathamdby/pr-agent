import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import {
  coerceReviewPayloadInput,
  createReviewPayloadSchema,
  formatReviewValidationError,
  type ReviewPublishContext,
} from "../reviewSchema.js";
import { publishReviewSummaryOnly } from "../publish/publishSummaryOnly.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import type { CiSummaryAuthor } from "../ci/authorCiSummary.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import type { ThreadPublishRunState } from "../publish/publishFindingBatch.js";
import { planInlinePlacements } from "../placement/reviewDiffPlacement.js";
import { refreshInstallationTokenIfNearExpiry } from "./refreshInstallationTokenIfNearExpiry.js";

const SUMMARY_TOOL_NAME = "publish_summary";

/** Overview/verdict fields only — accepted findings come from shared run state. */
const publishSummaryArgsSchema = createReviewPayloadSchema().omit({ findings: true });

const SUMMARY_TOOL_PARAMETERS = z.toJSONSchema(publishSummaryArgsSchema, {
  unrepresentable: "any",
}) as PiTool["parameters"];

export type SummaryPublishState = {
  published: boolean;
  lastValidationError: string | null;
};

export function createSummaryPublishState(
  initial?: Partial<Pick<SummaryPublishState, "published">>,
): SummaryPublishState {
  return {
    published: initial?.published ?? false,
    lastValidationError: null,
  };
}

/**
 * Live coverage note/partial flags for the one stable pi `publish_summary` executor.
 * Pi cannot swap tools after session creation; getters keep invocation-time values current.
 */
export type SummaryPublishLiveContext = {
  readonly getPartialCoverageNote: () => string | undefined;
  readonly getCoveragePartial: () => boolean;
};

/**
 * Orchestrator synthesis tool: wraps {@link publishReviewSummaryOnly} with a one-success latch.
 * Findings/table rows come from `runState.acceptedFindings` / `summaryPlacements`.
 * Validation failures return `{accepted:false,error}` (brief/thread contract), not throws.
 */
export function buildPublishSummaryTool(params: {
  cfg: Pick<Config, "piModel" | "features">;
  ctx: ReviewPublishContext;
  getToken: () => string;
  getTokenExpiresAtTs?: () => number | undefined;
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  refreshNearExpiry?: () => Promise<void>;
  recordPublishStep: RecordPublishStepWithCoordination;
  runState: ThreadPublishRunState;
  state: SummaryPublishState;
  cachedDiffIndex?: CachedPrDiffIndex;
  ciAuthor?: CiSummaryAuthor;
  live?: SummaryPublishLiveContext;
  partialCoverageNote?: string;
  /** True when a specialist failed: forces neutral check / error commit status (decision 21). */
  coveragePartial?: boolean;
  shouldAbortPublish?: () => Promise<boolean>;
  publishAbortState?: { staleHead?: boolean };
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
}): {
  piTool: PiTool;
  executor: AgentRunnerToolExecutor;
  getLastError: () => string | null;
  clearLastError: () => void;
} {
  const piTool: PiTool = {
    name: SUMMARY_TOOL_NAME,
    description: [
      "Publish the final review summary comment exactly once.",
      "Supply overview fields (prCharacter, estimatedEffort, relevantTests, securityConcerns, followUps, optional mergeVerdict).",
      "Accepted findings are taken from the server-owned run state — do not re-list unpublished speculative findings.",
    ].join(" "),
    parameters: SUMMARY_TOOL_PARAMETERS,
  };

  const executor: AgentRunnerToolExecutor = async (args) => {
    if (params.state.published) {
      return { ok: true, duplicate: true };
    }

    const { value: coercedArgs } = coerceReviewPayloadInput({
      ...args,
      findings: [],
    });

    const parsed = publishSummaryArgsSchema.safeParse(coercedArgs);
    if (!parsed.success) {
      const formatted = formatReviewValidationError(parsed.error);
      params.state.lastValidationError = formatted.message;
      return { accepted: false, error: formatted.message };
    }
    params.state.lastValidationError = null;

    await refreshInstallationTokenIfNearExpiry({
      getTokenExpiresAtTs: params.getTokenExpiresAtTs,
      refreshInstallationToken: params.refreshInstallationToken,
      refreshNearExpiry: params.refreshNearExpiry,
    });

    const acceptedFindings = [...params.runState.acceptedFindings];
    const summaryPlacements =
      params.runState.summaryPlacements != null && params.runState.summaryPlacements.length > 0
        ? params.runState.summaryPlacements
        : planInlinePlacements(acceptedFindings, params.cachedDiffIndex);

    const partialCoverageNote = params.live?.getPartialCoverageNote() ?? params.partialCoverageNote;
    const coveragePartial = params.live?.getCoveragePartial() ?? params.coveragePartial ?? false;

    const result = await publishReviewSummaryOnly({
      cfg: params.cfg,
      ctx: params.ctx,
      getToken: params.getToken,
      getTokenExpiresAtTs: params.getTokenExpiresAtTs,
      refreshNearExpiry: params.refreshNearExpiry,
      payload: {
        ...parsed.data,
        findings: acceptedFindings,
      },
      summaryPlacements,
      inlineReviewIds: params.runState.inlineReviewIds,
      recordPublishStep: params.recordPublishStep,
      ciAuthor: params.ciAuthor,
      partialCoverageNote,
      coveragePartial,
      cachedDiffIndex: params.cachedDiffIndex,
      shouldAbortPublish: params.shouldAbortPublish,
      publishAbortState: params.publishAbortState,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
    });

    params.state.published = true;
    return { ok: true, summaryCommentId: result.summaryCommentId };
  };

  return {
    piTool,
    executor,
    getLastError: () => params.state.lastValidationError,
    clearLastError: () => {
      params.state.lastValidationError = null;
    },
  };
}
