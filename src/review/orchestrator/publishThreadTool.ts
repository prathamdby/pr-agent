import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError, toAppError } from "../../errors/appError.js";
import { formatValidationIssues } from "../../util/formatValidationIssues.js";
import type { AgentEventsContext } from "../../agent/runtime/agentEventSink.js";
import { safeEmitDecisionEvent } from "../../agent/runtime/agentEventSink.js";
import type { Config } from "../../config.js";
import {
  type FindingBatchContext,
  type FindingBatchResult,
  publishFindingBatch,
} from "../publish/publishFindingBatch.js";
import { reviewFindingSchema, type ReviewFinding } from "../reviewSchema.js";
import {
  applyFindingLedgerDelta,
  createFindingLedger,
  type FindingLedger,
  type SpecialistId,
} from "./orchestratorTypes.js";
import { assertPhaseToolAllowed, type OrchestratorPhaseRef } from "./phaseToolPolicy.js";

const publishThreadSchema = v.object({
  findings: v.array(reviewFindingSchema),
});

type PublishedThreadOverlapHint = {
  readonly findingId: string;
  readonly severity: ReviewFinding["severity"];
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly detail: string;
};

export type PublishThreadToolResult =
  | (FindingBatchResult & {
      readonly publishedThreadOverlapHints: readonly PublishedThreadOverlapHint[];
    })
  | {
      readonly kind: "wrong_phase";
      readonly code: "review.tool_wrong_phase";
      readonly phase: string;
      readonly allowed: readonly string[];
      readonly error: string;
    };

type PublishThreadToolParams = Omit<FindingBatchContext, "source" | "ledger"> & {
  readonly phaseRef: OrchestratorPhaseRef;
  readonly initialLedger?: FindingLedger;
  readonly agentEvents?: AgentEventsContext;
  readonly cfg?: Pick<Config, "agentEventsEnabled">;
};

function overlapHints(
  ledger: FindingLedger,
  submittedFindings: readonly ReviewFinding[],
): PublishedThreadOverlapHint[] {
  const submittedFiles = new Set(submittedFindings.map((finding) => finding.file));
  return ledger.accepted.flatMap((accepted) => {
    if (accepted.kind === "summary_only") return [];
    const { finding } = accepted.placement;
    if (!submittedFiles.has(finding.file)) return [];
    return [
      {
        findingId: accepted.canonicalFingerprint,
        severity: finding.severity,
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        title: finding.title,
        detail: finding.detail,
      },
    ];
  });
}

export function buildPublishThreadTool(params: PublishThreadToolParams): {
  readonly piTool: PiTool;
  readonly executor: (args: Record<string, unknown>) => Promise<PublishThreadToolResult>;
  readonly setSource: (source: SpecialistId) => void;
  readonly getLedger: () => FindingLedger;
  readonly getPublishedBatchCount: () => number;
  readonly getStopReason: () => "superseded" | "stale_head" | null;
} {
  let source: SpecialistId | null = null;
  let stopReason: "superseded" | "stale_head" | null = null;
  let publishedBatchCount = 0;
  const { initialLedger, ...batchContext } = params;
  let ledger = initialLedger ?? createFindingLedger();
  const piTool: PiTool = {
    name: "publish_thread",
    description:
      "Publish one judged batch of review findings. An empty findings array is valid when no candidate survives judgment.",
    parameters: toJsonSchema(publishThreadSchema, { errorMode: "ignore" }),
  };
  const executor = async (args: Record<string, unknown>): Promise<PublishThreadToolResult> => {
    const gate = assertPhaseToolAllowed(params.phaseRef.current, "publish_thread");
    if (!gate.ok) {
      return {
        kind: "wrong_phase",
        code: gate.code,
        phase: gate.phase,
        allowed: gate.allowed,
        error: gate.error,
      };
    }
    const parsed = v.safeParse(publishThreadSchema, args);
    if (!parsed.success) {
      throw new AppError({
        code: "review.publish_thread_validation_failed",
        message: formatValidationIssues(parsed.issues, "publish_thread validation failed:"),
      });
    }
    if (source == null) {
      throw new AppError({
        code: "review.publish_thread_source_required",
        message: "Select the active specialist before calling publish_thread",
      });
    }

    let result: FindingBatchResult;
    try {
      result = await publishFindingBatch(parsed.output.findings, {
        ...batchContext,
        source,
        ledger,
      });
    } catch (error) {
      throw toAppError(error, {
        code: "review.publish_thread_failed",
        context: {
          owner: params.ctx.owner,
          repo: params.ctx.repo,
          pr: params.ctx.prNumber,
          source,
        },
      });
    }
    if (result.kind !== "stopped") {
      ledger = applyFindingLedgerDelta(ledger, result.delta);
      if (result.kind === "published") publishedBatchCount += 1;
      if (params.agentEvents && params.cfg) {
        const submittedCount = parsed.output.findings.length;
        const acceptedCount = result.delta.accepted.length;
        safeEmitDecisionEvent(params.agentEvents, params.cfg, {
          specialist: source,
          phase: "judgment",
          submittedCount,
          acceptedCount,
          rejectedCount: Math.max(0, submittedCount - acceptedCount),
        });
      }
    } else {
      stopReason = result.reason;
    }
    return {
      ...result,
      publishedThreadOverlapHints: overlapHints(ledger, parsed.output.findings),
    };
  };

  return {
    piTool,
    executor,
    setSource: (nextSource) => {
      source = nextSource;
    },
    getLedger: () => ledger,
    getPublishedBatchCount: () => publishedBatchCount,
    getStopReason: () => stopReason,
  };
}
