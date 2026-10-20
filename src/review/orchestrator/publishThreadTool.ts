import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toToolParameters } from "../../agent/tools/toolParams.ts";
import { AppError, toAppError } from "../../errors/appError.ts";
import { parseToolInput } from "../../agent/tools/parseToolInput.ts";
import { safeEmitDecisionEvent } from "../../agent/runtime/agentEventSink.ts";
import {
  type FindingBatchInput,
  type FindingBatchResult,
  findingIdScope,
  publishFindingBatch,
  reconciledFindingKey,
} from "../publish/publishFindingBatch.ts";
import type { PublishStopReason, ReviewPublishSession } from "../publish/reviewPublishSession.ts";
import type { SpecialistReport } from "./specialistReport.ts";
import {
  cappedFindingSeverity,
  reviewFindingEntries,
  reviewFindingSchema,
  reviewPayloadFromFindings,
  type ReviewFinding,
} from "../reviewSchema.ts";
import {
  REVIEW_FINDING_SEVERITY_RATIONALE_MAX_CHARS,
  REVIEW_SEVERITY_RANK,
} from "../../settings/index.ts";
import { redactReviewPayloadSecrets } from "../findings/reviewPublicOutput.ts";
import { compareReviewFindingsBySeverityFileLine } from "../findings/reviewFindingSort.ts";
import { reviewFindingPlacementKey } from "../placement/reviewDiffPlacement.ts";
import { capFindingDetail, type FindingInventory } from "../findingIdentity/findingInventory.ts";
import { derivedFindingId, isFindingId, mintFindingId } from "../findingIdentity/findingMarker.ts";
import {
  MAX_OVERLAP_ROUNDS,
  reconcileObservation,
  type AcceptedThisRun,
  type ObservationRelation,
  type OverlapCandidate,
  type ReconcileOutcome,
} from "../findingIdentity/findingReconcile.ts";
import {
  applyFindingLedgerDelta,
  createFindingLedger,
  type FindingLedger,
  type SpecialistId,
} from "./orchestratorTypes.ts";
import { assertPhaseToolAllowed, type OrchestratorPhaseRef } from "./phaseToolPolicy.ts";
import type { RecoveryDecision } from "../recovery/reviewRecovery.ts";

const findingIdsParam = v.pipe(
  v.array(v.string()),
  v.minLength(1),
  v.description("Finding IDs from the finding inventory or from earlier accepted findings."),
);

const relationSchema = v.pipe(
  v.variant("kind", [
    v.object({ kind: v.literal("new") }),
    v.object({
      kind: v.literal("continues"),
      findingId: v.pipe(v.string(), v.description("The existing finding this one reports again.")),
    }),
    v.object({
      kind: v.literal("distinct_from"),
      findingIds: findingIdsParam,
      reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    }),
    v.object({ kind: v.literal("uncertain"), findingIds: findingIdsParam }),
  ]),
  v.description(
    "How this finding relates to findings the pull request already has. Omit only for a finding with no existing finding nearby.",
  ),
);

const publishThreadSchema = v.object({
  findings: v.array(
    v.object({
      ...reviewFindingEntries,
      severityRationale: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(REVIEW_FINDING_SEVERITY_RATIONALE_MAX_CHARS),
        v.description(
          "Required private sentence for the final severity. Stored with the finding and never rendered.",
        ),
      ),
      relation: v.optional(relationSchema),
    }),
  ),
});

const checkedFindingsSchema = v.object({ findings: v.array(reviewFindingSchema) });

type SubmittedRelation = v.InferOutput<typeof relationSchema>;

type SubmittedFinding = {
  readonly finding: ReviewFinding;
  readonly relation: ObservationRelation | string;
};

type OverlapQuestionReport = {
  readonly findingIndex: number;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly candidates: readonly OverlapCandidate[];
};

type RejectedRelationReport = {
  readonly findingIndex: number;
  readonly title: string;
  readonly reason: string;
};

export type PublishThreadToolResult =
  | FindingBatchResult
  | {
      readonly kind: "wrong_phase";
      readonly code: "review.tool_wrong_phase";
      readonly phase: string;
      readonly allowed: readonly string[];
      readonly error: string;
    };

type PublishThreadToolParams = {
  readonly phaseRef: OrchestratorPhaseRef;
  readonly session: ReviewPublishSession;
  readonly inventory: FindingInventory;
  readonly policy?: Omit<FindingBatchInput, "source" | "ledger" | "reconciled">;
  readonly initialLedger?: FindingLedger;
};

function observationRelation(
  relation: SubmittedRelation | undefined,
): ObservationRelation | string {
  if (relation == null || relation.kind === "new") return { kind: "new" };
  const ids = relation.kind === "continues" ? [relation.findingId] : relation.findingIds;
  const malformed = ids.filter((id) => !isFindingId(id));
  if (malformed.length > 0) return `Unknown finding ids ${malformed.join(", ")}.`;
  const findingIds = ids.filter(isFindingId);
  switch (relation.kind) {
    case "continues": {
      const [findingId] = findingIds;
      return findingId == null
        ? "A continues relation needs a finding id."
        : { kind: "continues", findingId };
    }
    case "distinct_from":
      return { kind: "distinct_from", findingIds, reason: relation.reason };
    case "uncertain":
      return { kind: "uncertain", findingIds };
    default: {
      const exhaustive: never = relation;
      return exhaustive;
    }
  }
}

function acceptedThisRun(ledger: FindingLedger): AcceptedThisRun[] {
  return ledger.accepted.map((accepted) => {
    const detail = capFindingDetail(accepted.placement.finding.detail);
    return {
      id: accepted.findingId,
      path: accepted.placement.finding.file,
      startLine: accepted.placement.finding.startLine,
      endLine: accepted.placement.finding.endLine,
      title: accepted.placement.finding.title,
      ...(detail != null ? { detail } : {}),
      url: accepted.placement.inlineCommentUrl ?? "",
    };
  });
}

function normalizedSubstance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function repeatsFinding(earlier: ReviewFinding, candidate: ReviewFinding): boolean {
  if (reviewFindingPlacementKey(earlier) === reviewFindingPlacementKey(candidate)) return true;
  return (
    earlier.file === candidate.file &&
    earlier.startLine <= candidate.endLine &&
    candidate.startLine <= earlier.endLine &&
    normalizedSubstance(earlier.title) === normalizedSubstance(candidate.title) &&
    normalizedSubstance(earlier.detail) === normalizedSubstance(candidate.detail)
  );
}

function repeatedInBatch(findings: readonly ReviewFinding[]): ReadonlySet<number> {
  const seen: ReviewFinding[] = [];
  const repeated = new Set<number>();
  const byPriority = findings
    .map((finding, index) => ({ finding, index }))
    .toSorted((left, right) =>
      compareReviewFindingsBySeverityFileLine(left.finding, right.finding),
    );
  for (const { finding, index } of byPriority) {
    if (seen.some((earlier) => repeatsFinding(earlier, finding))) repeated.add(index);
    seen.push(finding);
  }
  return repeated;
}

function severityMovement(
  report: SpecialistReport | null,
  findings: readonly ReviewFinding[],
): { readonly severityRaised: number; readonly severityLowered: number } {
  let severityRaised = 0;
  let severityLowered = 0;
  for (const finding of findings) {
    const matches = (report?.findings ?? []).filter(
      (row) =>
        row.file === finding.file &&
        row.startLine === finding.startLine &&
        row.endLine === finding.endLine &&
        row.title === finding.title,
    );
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match == null) continue;
    const judgedRank = REVIEW_SEVERITY_RANK[finding.severity];
    const suggestedRank = REVIEW_SEVERITY_RANK[match.suggestedSeverity];
    if (judgedRank < suggestedRank) severityRaised += 1;
    else if (judgedRank > suggestedRank) severityLowered += 1;
  }
  return { severityRaised, severityLowered };
}

function validationFailed(message: string): AppError {
  return new AppError({ domain: "review", kind: "publish_thread_validation_failed", message });
}

function overlapUnanswered(
  questions: readonly OverlapQuestionReport[],
  rejected: readonly RejectedRelationReport[],
): AppError {
  return new AppError({
    domain: "review",
    kind: "publish_thread_overlap_unanswered",
    message: [
      "publish_thread published nothing: some findings need a relation answer first.",
      "For each overlap question, set that finding's relation to continues, distinct_from, or uncertain with the listed finding IDs. Fix each rejected relation. Then call publish_thread again with the whole batch. A finding still unanswered on that call lands summary-only.",
      JSON.stringify({ overlapQuestions: questions, rejectedRelations: rejected }, null, 2),
    ].join("\n"),
  });
}

export function buildPublishThreadTool(params: PublishThreadToolParams): {
  readonly piTool: PiTool;
  readonly executor: (args: Record<string, unknown>) => Promise<PublishThreadToolResult>;
  readonly publishWithoutModel: (
    findings: readonly ReviewFinding[],
  ) => Promise<PublishThreadToolResult>;
  readonly setSource: (source: SpecialistId) => void;
  readonly setReport: (report: SpecialistReport) => void;
  readonly getLedger: () => FindingLedger;
  readonly getPublishedBatchCount: () => number;
  readonly getStopReason: () => PublishStopReason | null;
  readonly replay: (decision: RecoveryDecision, withoutEvidence?: boolean) => Promise<void>;
} {
  let source: SpecialistId | null = null;
  let specialistReport: SpecialistReport | null = null;
  let stopReason: PublishStopReason | null = null;
  let publishedBatchCount = 0;
  let overlapRoundsUsed = 0;
  const { session, inventory } = params;
  let ledger = params.initialLedger ?? createFindingLedger();
  const piTool: PiTool = {
    name: "publish_thread",
    description:
      "Publish the judged findings for the active specialist as one batch. Pass only the candidates that survive judgment, each with its relation to existing findings; an empty findings array is valid and records that none did. A batch whose findings sit near existing findings without a matching relation fails once with overlap questions to answer.",
    parameters: toToolParameters(publishThreadSchema),
  };

  const reconcileBatch = (
    submitted: readonly SubmittedFinding[],
    redacted: readonly ReviewFinding[],
    repeated: ReadonlySet<number>,
    overlapRoundsLeft: number,
    batchSource: SpecialistId,
  ): Map<string, ReconcileOutcome> => {
    const accepted = acceptedThisRun(ledger);
    const scope = findingIdScope(session, batchSource);
    const occurrences = new Map<string, number>();
    const threadBudgetSpent =
      ledger.threadBudgetExhausted ||
      ledger.threadCallCount >= session.cfg.review.maxThreadPublishCalls;
    const outcomes = new Map<string, ReconcileOutcome>();
    const questions: OverlapQuestionReport[] = [];
    const rejected: RejectedRelationReport[] = [];
    for (const [findingIndex, { finding, relation }] of submitted.entries()) {
      if (repeated.has(findingIndex)) continue;
      const key = reconciledFindingKey(redacted[findingIndex] ?? finding);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const mint = () =>
        scope == null ? mintFindingId() : derivedFindingId([...scope, key, String(occurrence)]);
      const step =
        typeof relation === "string"
          ? { rejected: relation }
          : reconcileObservation({
              observation: finding,
              relation,
              inventory,
              acceptedThisRun: accepted,
              overlapRoundsLeft,
              mint,
            });
      const unanswered =
        !("outcome" in step) ||
        (step.outcome.kind === "summary_only" && step.outcome.reason === "unanswered_overlap");
      if (threadBudgetSpent && unanswered) continue;
      if ("outcome" in step) {
        outcomes.set(key, step.outcome);
      } else if (overlapRoundsLeft <= 0) {
        outcomes.set(key, {
          kind: "summary_only",
          id: mint(),
          reason: "unanswered_overlap",
        });
      } else if ("question" in step) {
        questions.push({
          findingIndex,
          file: finding.file,
          startLine: finding.startLine,
          endLine: finding.endLine,
          title: finding.title,
          candidates: step.question.candidates,
        });
      } else {
        rejected.push({ findingIndex, title: finding.title, reason: step.rejected });
      }
    }
    if (questions.length > 0 || rejected.length > 0) {
      overlapRoundsUsed += 1;
      throw overlapUnanswered(questions, rejected);
    }
    return outcomes;
  };

  const publish = async (
    submitted: readonly SubmittedFinding[],
    overlapRoundsLeft: number,
    judged: boolean,
  ): Promise<PublishThreadToolResult> => {
    if (source == null) {
      throw new AppError({
        domain: "review",
        kind: "publish_thread_source_required",
        message: "Select the active specialist before calling publish_thread",
      });
    }
    const redacted = redactReviewPayloadSecrets(
      reviewPayloadFromFindings(submitted.map((entry) => entry.finding)),
    ).findings.map((finding) => ({
      ...finding,
      severity: cappedFindingSeverity({
        severity: finding.severity,
        testsLens: source === "tests",
        anchorPath: finding.file,
        judged,
      }),
    }));
    const prepared = submitted.map((entry, index) => ({
      finding: redacted[index],
      relation: entry.relation,
    }));
    const repeated = repeatedInBatch(redacted);
    const outcomes = reconcileBatch(prepared, redacted, repeated, overlapRoundsLeft, source);
    const findings = redacted.filter((_, index) => !repeated.has(index));

    let result: FindingBatchResult;
    try {
      result = await publishFindingBatch(findings, session, {
        ...params.policy,
        source,
        ledger,
        reconciled: { inventory, outcomes },
        judged,
      });
    } catch (error) {
      throw toAppError(error, {
        domain: "review",
        kind: "publish_thread_failed",
        context: {
          owner: session.ctx.owner,
          repo: session.ctx.repo,
          pr: session.ctx.prNumber,
          source,
        },
      });
    }
    if (result.kind !== "stopped") {
      ledger = applyFindingLedgerDelta(ledger, result.delta);
      if (result.kind === "published") publishedBatchCount += 1;
      if (session.agentEvents) {
        const submittedCount = submitted.length;
        const acceptedCount = result.delta.accepted.length + result.delta.reaffirmed.length;
        safeEmitDecisionEvent(session.agentEvents, session.cfg, {
          specialist: source,
          phase: "judgment",
          submittedCount,
          acceptedCount,
          rejectedCount: Math.max(0, submittedCount - acceptedCount),
          ...severityMovement(specialistReport, findings),
        });
      }
    } else {
      stopReason = result.reason;
    }
    return result;
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
    const options = { toolName: "publish_thread", errorTitle: "publish_thread validation failed:" };
    const parsed = parseToolInput(publishThreadSchema, args, options);
    if (!parsed.ok) throw validationFailed(parsed.error);
    const checked = parseToolInput(checkedFindingsSchema, args, options);
    if (!checked.ok) throw validationFailed(checked.error);
    const submitted = checked.value.findings.map((finding, index) => ({
      finding,
      relation: observationRelation(parsed.value.findings[index]?.relation),
    }));
    return publish(submitted, Math.max(0, MAX_OVERLAP_ROUNDS - overlapRoundsUsed), true);
  };

  return {
    piTool,
    executor,
    publishWithoutModel: async (findings) => {
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
      return publish(
        findings.map((finding) => ({ finding, relation: { kind: "new" } })),
        0,
        false,
      );
    },
    setSource: (nextSource) => {
      source = nextSource;
      overlapRoundsUsed = 0;
      specialistReport = null;
    },
    setReport: (report) => {
      specialistReport = report;
    },
    getLedger: () => ledger,
    getPublishedBatchCount: () => publishedBatchCount,
    getStopReason: () => stopReason,
    replay: async (decision, withoutEvidence) => {
      const canonical = decision.prepared.artifact.canonical;
      if (canonical.kind !== "threads") return;
      const result = await publishFindingBatch([], session, {
        ...params.policy,
        source: canonical.source,
        ledger,
        recoveryDecision: decision,
        recoveryWithoutEvidence: withoutEvidence,
      });
      if (result.kind === "stopped") {
        stopReason = result.reason;
        return;
      }
      ledger = applyFindingLedgerDelta(ledger, result.delta);
    },
  };
}
