import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import {
  coerceReviewPayloadInput,
  createReviewPayloadSchema,
  formatReviewValidationError,
} from "../reviewSchema.js";
import { toolAccepted, toolRejected } from "./structuredToolResult.js";

const SUMMARY_TOOL_NAME = "publish_summary";

/** Overview/verdict fields only — accepted findings come from shared run state. */
const publishSummaryArgsSchema = createReviewPayloadSchema().omit({ findings: true });

export type CapturedSummaryOverview = z.infer<typeof publishSummaryArgsSchema>;

const SUMMARY_TOOL_PARAMETERS = z.toJSONSchema(publishSummaryArgsSchema, {
  unrepresentable: "any",
}) as PiTool["parameters"];

export type SummaryCaptureState = {
  captured: CapturedSummaryOverview | null;
  lastValidationError: string | null;
};

export function createSummaryCaptureState(): SummaryCaptureState {
  return {
    captured: null,
    lastValidationError: null,
  };
}

/**
 * Stable pi `publish_summary` executor: validates and captures the LLM overview payload.
 * Does not publish — the host {@link finalizeReviewSummary} owns the single
 * {@link publishReviewSummaryOnly} call site.
 */
export function buildPublishSummaryTool(params: { state: SummaryCaptureState }): {
  piTool: PiTool;
  executor: AgentRunnerToolExecutor;
  getLastError: () => string | null;
  clearLastError: () => void;
  getCapturedOverview: () => CapturedSummaryOverview | null;
  hasCaptured: () => boolean;
} {
  const piTool: PiTool = {
    name: SUMMARY_TOOL_NAME,
    description: [
      "Submit the final review summary overview exactly once.",
      "Supply overview fields (prCharacter, estimatedEffort, relevantTests, securityConcerns, followUps, optional mergeVerdict).",
      "Accepted findings are taken from the server-owned run state — do not re-list unpublished speculative findings.",
    ].join(" "),
    parameters: SUMMARY_TOOL_PARAMETERS,
  };

  const executor: AgentRunnerToolExecutor = async (args) => {
    if (params.state.captured != null) {
      return toolAccepted({
        duplicate: true,
        overview: params.state.captured,
      });
    }

    const { value: coercedArgs } = coerceReviewPayloadInput({
      ...args,
      findings: [],
    });

    const parsed = publishSummaryArgsSchema.safeParse(coercedArgs);
    if (!parsed.success) {
      const formatted = formatReviewValidationError(parsed.error);
      params.state.lastValidationError = formatted.message;
      return toolRejected(formatted.message);
    }
    params.state.lastValidationError = null;
    params.state.captured = parsed.data;

    return toolAccepted({
      duplicate: false,
      overview: parsed.data,
    });
  };

  return {
    piTool,
    executor,
    getLastError: () => params.state.lastValidationError,
    clearLastError: () => {
      params.state.lastValidationError = null;
    },
    getCapturedOverview: () => params.state.captured,
    hasCaptured: () => params.state.captured != null,
  };
}
