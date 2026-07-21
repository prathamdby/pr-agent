import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { reviewFindingSchema, type ReviewPublishContext } from "../reviewSchema.js";
import { publishFindingBatch, type FindingBatchResult } from "../publish/publishFindingBatch.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";
import type { PublishAbortGate } from "../publish/publishAbortGate.js";
import { toolAccepted, toolRejected } from "./structuredToolResult.js";
import type { ThreadPublishRunState } from "../publish/threadPublishRunState.js";
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

export type PublishThreadToolValue = FindingBatchResult & {
  readonly sameFilePublishedThreads: readonly PublishedThreadOverlapHint[];
  readonly acceptedAsSummaryOnly?: boolean;
};

/** Facade handle for judgment / ensure-report callers that only need turn lifecycle. */
export type PublishThreadToolHandle = {
  readonly beginTurn: () => void;
  readonly hadSuccessfulCallThisTurn: () => boolean;
  readonly getLastError: () => string | null;
  readonly clearLastError: () => void;
};

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
  token: InstallationTokenHandle;
  recordPublishStep: RecordPublishStepWithCoordination;
  runState: ThreadPublishRunState;
  cachedDiffIndex?: CachedPrDiffIndex;
  abortGate: PublishAbortGate;
}): {
  piTool: PiTool;
  executor: AgentRunnerToolExecutor;
  getLastError: () => string | null;
  clearLastError: () => void;
  beginTurn: () => void;
  /** True when this turn made at least one successful `publish_thread` call (empty findings count). */
  hadSuccessfulCallThisTurn: () => boolean;
} {
  let lastError: string | null = null;
  let successfulCallsThisTurn = 0;

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
      return toolRejected(lastError);
    }
    lastError = null;

    const priorAccepted = [...params.runState.acceptedFindings];
    const overlap = sameFilePublishedThreadHints(parsed.data.findings, priorAccepted);

    const batchResult = await publishFindingBatch(parsed.data.findings, {
      cfg: params.cfg,
      ctx: params.ctx,
      token: params.token,
      cachedDiffIndex: params.cachedDiffIndex,
      recordPublishStep: params.recordPublishStep,
      abortGate: params.abortGate,
      runState: params.runState,
    });

    // Empty findings and budget_exhausted still count as a successful tool call (decision 25).
    successfulCallsThisTurn += 1;

    const value: PublishThreadToolValue = {
      ...batchResult,
      sameFilePublishedThreads: overlap,
      ...(batchResult.kind === "budget_exhausted" ? { acceptedAsSummaryOnly: true } : {}),
    };
    return toolAccepted(value);
  };

  return {
    piTool,
    executor,
    getLastError: () => lastError,
    clearLastError: () => {
      lastError = null;
    },
    beginTurn: () => {
      successfulCallsThisTurn = 0;
    },
    hadSuccessfulCallThisTurn: () => successfulCallsThisTurn > 0,
  };
}
