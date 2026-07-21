import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { reviewFindingSchema, type ReviewPublishContext } from "../reviewSchema.js";
import {
  publishFindingBatch,
  type FindingBatchContext,
  type FindingBatchResult,
  type ThreadPublishRunState,
} from "../publish/publishFindingBatch.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import { refreshInstallationTokenIfNearExpiry } from "./refreshInstallationTokenIfNearExpiry.js";
import {
  sameFilePublishedThreadHints,
  type SameFilePublishedThreadHint,
} from "./sameFilePublishedThreadHints.js";

const THREAD_TOOL_NAME = "publish_thread";

const publishThreadArgsSchema = z.object({
  findings: z.array(reviewFindingSchema).default([]),
});

const THREAD_TOOL_PARAMETERS = z.toJSONSchema(publishThreadArgsSchema, {
  unrepresentable: "any",
}) as PiTool["parameters"];

export type PublishedThreadOverlapHint = SameFilePublishedThreadHint;

export type PublishThreadToolResult = FindingBatchResult & {
  readonly sameFilePublishedThreads: readonly PublishedThreadOverlapHint[];
  readonly acceptedAsSummaryOnly?: boolean;
};

export function createThreadPublishRunState(
  overrides: Partial<ThreadPublishRunState> = {},
): ThreadPublishRunState {
  return {
    postedFingerprints: new Set(),
    postedInlineCount: 0,
    batchCount: 0,
    inlineReviewIds: [],
    acceptedFindings: [],
    partialSpecialists: [],
    summaryPlacements: [],
    ...overrides,
  };
}

function formatThreadValidationError(error: z.ZodError): string {
  const lines = [`${THREAD_TOOL_NAME} validation failed:`];
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    lines.push(`- ${path}: ${issue.message}`);
  }
  lines.push("Resubmit findings matching the review finding schema, or an empty findings array.");
  return lines.join("\n");
}

/**
 * Orchestrator judgment tool: wraps {@link publishFindingBatch}, preserves shared run state,
 * and returns same-file overlap hints for the next judgment turn.
 */
export function buildPublishThreadTool(params: {
  cfg: Pick<Config, "piModel" | "features">;
  ctx: ReviewPublishContext;
  getToken: () => string;
  getTokenExpiresAtTs?: () => number | undefined;
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  recordPublishStep: RecordPublishStepWithCoordination;
  runState: ThreadPublishRunState;
  cachedDiffIndex?: CachedPrDiffIndex;
  shouldAbortPublish?: FindingBatchContext["shouldAbortPublish"];
  publishAbortState?: FindingBatchContext["publishAbortState"];
}): {
  piTool: PiTool;
  executor: AgentRunnerToolExecutor;
  getLastError: () => string | null;
  clearLastError: () => void;
} {
  let lastError: string | null = null;

  const piTool: PiTool = {
    name: THREAD_TOOL_NAME,
    description: [
      "Publish one incremental inline thread batch for the current judgment turn.",
      "Pass the worthy findings (or an empty array when nothing should publish).",
      "Zero-thread publishes are valid. The result reports suppressions, drops, and same-file overlap with already-accepted threads.",
    ].join(" "),
    parameters: THREAD_TOOL_PARAMETERS,
  };

  const executor: AgentRunnerToolExecutor = async (args) => {
    const parsed = publishThreadArgsSchema.safeParse(args);
    if (!parsed.success) {
      lastError = formatThreadValidationError(parsed.error);
      return { accepted: false, error: lastError };
    }
    lastError = null;

    const priorAccepted = [...params.runState.acceptedFindings];
    const overlap = sameFilePublishedThreadHints(parsed.data.findings, priorAccepted);

    await refreshInstallationTokenIfNearExpiry({
      getTokenExpiresAtTs: params.getTokenExpiresAtTs,
      refreshInstallationToken: params.refreshInstallationToken,
    });

    const batchResult = await publishFindingBatch(parsed.data.findings, {
      cfg: params.cfg,
      ctx: params.ctx,
      getToken: params.getToken,
      cachedDiffIndex: params.cachedDiffIndex,
      recordPublishStep: params.recordPublishStep,
      shouldAbortPublish: params.shouldAbortPublish,
      publishAbortState: params.publishAbortState,
      runState: params.runState,
      tokenExpiresAtTs: params.getTokenExpiresAtTs?.(),
    });

    const result: PublishThreadToolResult = {
      ...batchResult,
      sameFilePublishedThreads: overlap,
      ...(batchResult.kind === "budget_exhausted" ? { acceptedAsSummaryOnly: true } : {}),
    };
    return result;
  };

  return {
    piTool,
    executor,
    getLastError: () => lastError,
    clearLastError: () => {
      lastError = null;
    },
  };
}

/** Re-export run state type for orchestrator callers. */
export type { ThreadPublishRunState };
