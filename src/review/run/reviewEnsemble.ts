import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentRunnerProvider, AgentRunnerSession } from "../../agent/providers/interface.js";
import { wrapUntrustedBlock } from "../../agent/prompts/promptBlocks.js";
import type { Config } from "../../config.js";
import { logInfo, logWarn } from "../../evlog.js";
import {
  REVIEW_SYNTHESIS_CONTEXT_MAX_CHARS,
  REVIEW_SYNTHESIS_LOW_SEVERITY_DETAIL_MAX_CHARS,
  REVIEW_SYNTHESIS_LOW_SEVERITY_EVIDENCE_MAX_CHARS,
} from "../../settings/index.js";
import {
  buildReviewerSystemPrompt,
  REVIEWER_IDS,
  type ReviewerId,
} from "../prompts/reviewerPrompt.js";
import {
  buildValidatorSystemPrompt,
  buildValidatorUserContent,
} from "../prompts/validatorPrompt.js";
import { recordReviewMetric } from "./reviewRunMetrics.js";
import { sendReviewAgentTurn } from "./reviewRunAgentSend.js";
import { createReviewToolCallRecorder } from "./reviewToolCallRecorder.js";
import type { ReviewSessionRole } from "./reviewSessionRole.js";
import type { ReviewBudgetTier } from "./reviewSizeBudget.js";

export { REVIEWER_IDS };
export type { ReviewerId };

const reviewerFindingSchema = z.object({
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  title: z.string().min(1).max(160),
  detail: z.string().min(1).max(6000),
  fixPrompt: z.string().max(4000).optional(),
  suggestedCode: z.string().max(8000).optional(),
  confidence: z.number().int().min(1).max(5),
  category: z.enum(["bug", "security", "performance", "style"]),
  evidence: z.string().min(1).max(3000),
});

const reviewerReportSchema = z.object({
  coverage: z.string().min(1).max(2000),
  findings: z.array(reviewerFindingSchema).max(128),
  residualRisks: z.array(z.string().max(1000)).max(20),
  testingGaps: z.array(z.string().max(1000)).max(20),
});

export type ReviewerReport = z.infer<typeof reviewerReportSchema> & {
  readonly reviewer: ReviewerId;
};

const validatorVerdictSchema = z.object({
  confirmed: z.boolean(),
  reason: z.string().min(1).max(1000),
});

function reviewerSessionRole(reviewer: ReviewerId): ReviewSessionRole {
  return `reviewer:${reviewer}`;
}

function buildSubmitReviewerReportTool(
  onReport: (report: z.infer<typeof reviewerReportSchema>) => void,
): {
  tool: PiTool;
  executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    tool: {
      name: "submitReviewerReport",
      description:
        "Submit your complete Reviewer report exactly once. This is internal and does not publish to GitHub.",
      parameters: z.toJSONSchema(reviewerReportSchema, {
        unrepresentable: "any",
      }) as PiTool["parameters"],
    },
    executor: async (args) => {
      const report = reviewerReportSchema.parse(args);
      onReport(report);
      return { ok: true };
    },
  };
}

async function runReviewer(params: {
  cfg: Config;
  runner: AgentRunnerProvider;
  reviewer: ReviewerId;
  cwd?: string;
  userContent: string;
  readOnlyTools: readonly PiTool[];
  readOnlyExecutors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  refreshBeforeTool?: (toolName: string) => Promise<void>;
  signal?: AbortSignal;
  budgetTier?: ReviewBudgetTier;
}): Promise<ReviewerReport> {
  let submitted: z.infer<typeof reviewerReportSchema> | undefined;
  const submit = buildSubmitReviewerReportTool((report) => {
    if (submitted) throw new Error("Reviewer report already submitted");
    submitted = report;
  });
  const sessionRole = reviewerSessionRole(params.reviewer);
  const session = await params.runner.createSession({
    cfg: params.cfg,
    cwd: params.cwd,
    signal: params.signal,
    systemPrompt: buildReviewerSystemPrompt(params.reviewer, {
      budgetTier: params.budgetTier,
    }),
    tools: [...params.readOnlyTools, submit.tool],
    executors: { ...params.readOnlyExecutors, submitReviewerReport: submit.executor },
    refreshBeforeTool: params.refreshBeforeTool,
    onToolCallMetric: createReviewToolCallRecorder(sessionRole),
  });
  try {
    await sendReviewAgentTurn(
      session,
      params.userContent,
      {
        maxToolRounds: params.cfg.maxToolRoundsReviewer,
        signal: params.signal,
      },
      sessionRole,
    );
    if (!submitted) throw new Error(`${params.reviewer} Reviewer agent did not submit a report`);
    return { reviewer: params.reviewer, ...submitted };
  } finally {
    await session.dispose();
  }
}

export async function runReviewerEnsemble(params: {
  cfg: Config;
  runner: AgentRunnerProvider;
  cwd?: string;
  userContent: string;
  readOnlyTools: readonly PiTool[];
  readOnlyExecutors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  refreshBeforeTool?: (toolName: string) => Promise<void>;
  signal?: AbortSignal;
  concurrency?: number;
  selectedReviewerIds?: readonly ReviewerId[];
  budgetTier?: ReviewBudgetTier;
}): Promise<{
  reports: ReviewerReport[];
  failed: ReviewerId[];
  selected: ReviewerId[];
  omitted: ReviewerId[];
}> {
  const startedAt = Date.now();
  const reports: ReviewerReport[] = [];
  const failed: ReviewerId[] = [];
  const selected = [...(params.selectedReviewerIds ?? REVIEWER_IDS)].sort(
    (a, b) => REVIEWER_IDS.indexOf(a) - REVIEWER_IDS.indexOf(b),
  );
  if (!selected.includes("correctness") || !selected.includes("security")) {
    throw new Error("Selected Reviewer roster must include correctness and security");
  }
  const selectedSet = new Set<string>(selected);
  const omitted = REVIEWER_IDS.filter((id) => !selectedSet.has(id));
  const queue = [...selected];
  const concurrency = Math.max(
    1,
    Math.min(params.concurrency ?? params.cfg.reviewAgentConcurrency, Math.max(1, selected.length)),
  );
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0 && !params.signal?.aborted) {
      const reviewer = queue.shift();
      if (!reviewer) return;
      try {
        reports.push(
          await runReviewer({
            ...params,
            reviewer,
            budgetTier: params.budgetTier,
          }),
        );
      } catch (error) {
        if (params.signal?.aborted) return;
        failed.push(reviewer);
        logWarn("reviewer_agent_failed", {
          reviewer,
          session_role: reviewerSessionRole(reviewer),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);
  reports.sort((a, b) => REVIEWER_IDS.indexOf(a.reviewer) - REVIEWER_IDS.indexOf(b.reviewer));
  failed.sort((a, b) => REVIEWER_IDS.indexOf(a) - REVIEWER_IDS.indexOf(b));
  const candidateFindings = reports.reduce((total, report) => total + report.findings.length, 0);
  const durationMs = Date.now() - startedAt;
  const requiredFailed = failed.includes("correctness") || failed.includes("security");
  // Degraded review = optional selected Reviewer agent gaps only (ADR 0022 / 0023).
  // Reviewer agents omitted by Review budget tier are expected policy, not degradation.
  const degraded = failed.length > 0 && !requiredFailed;
  recordReviewMetric({
    kind: "ensemble_completed",
    completedReviewerIds: reports.map((report) => report.reviewer),
    failedReviewerIds: failed,
    selectedReviewerIds: selected,
    omittedReviewerIds: omitted,
    candidateFindings,
    durationMs,
    degraded,
  });
  logInfo("review_ensemble_completed", {
    budget_tier: params.budgetTier ?? null,
    selected: selected.length,
    selected_reviewer_ids: selected,
    omitted_reviewer_ids: omitted,
    completed: reports.length,
    failed: failed.length,
    failed_reviewer_ids: failed,
    candidate_findings: candidateFindings,
    duration_ms: durationMs,
    degraded,
  });
  return { reports, failed, selected, omitted };
}

export async function validateHighRiskFindings(params: {
  cfg: Config;
  runner: AgentRunnerProvider;
  cwd?: string;
  reports: readonly ReviewerReport[];
  readOnlyTools: readonly PiTool[];
  readOnlyExecutors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  refreshBeforeTool?: (toolName: string) => Promise<void>;
  signal?: AbortSignal;
  concurrency?: number;
  maxCandidates?: number;
}): Promise<{ reports: ReviewerReport[]; truncatedCandidates: number }> {
  const startedAt = Date.now();
  const candidates = params.reports.flatMap((report, reportIndex) =>
    report.findings.flatMap((finding, findingIndex) =>
      finding.severity === "P0" || finding.severity === "P1"
        ? [{ reportIndex, findingIndex, finding }]
        : [],
    ),
  );
  const maxCandidates = Math.max(
    0,
    params.maxCandidates ?? params.cfg.reviewValidationMaxCandidates,
  );
  const queue = candidates.slice(0, maxCandidates);
  const truncatedCandidates = candidates.length - queue.length;
  const dropped = new Set<string>();
  const concurrency = Math.max(
    1,
    Math.min(params.concurrency ?? params.cfg.reviewAgentConcurrency, Math.max(1, queue.length)),
  );
  const validationTool: PiTool = {
    name: "submitValidation",
    description: "Submit whether the candidate finding is confirmed by the changed code.",
    parameters: z.toJSONSchema(validatorVerdictSchema, {
      unrepresentable: "any",
    }) as PiTool["parameters"],
  };
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0 && !params.signal?.aborted) {
      const candidate = queue.shift();
      if (!candidate) return;
      let verdict: z.infer<typeof validatorVerdictSchema> | undefined;
      let session: AgentRunnerSession | undefined;
      try {
        session = await params.runner.createSession({
          cfg: params.cfg,
          cwd: params.cwd,
          signal: params.signal,
          systemPrompt: buildValidatorSystemPrompt(),
          tools: [...params.readOnlyTools, validationTool],
          executors: {
            ...params.readOnlyExecutors,
            submitValidation: async (args) => {
              verdict = validatorVerdictSchema.parse(args);
              return { ok: true };
            },
          },
          refreshBeforeTool: params.refreshBeforeTool,
          onToolCallMetric: createReviewToolCallRecorder("validator"),
        });
        await sendReviewAgentTurn(
          session,
          buildValidatorUserContent(candidate.finding),
          {
            maxToolRounds: params.cfg.maxToolRoundsValidator,
            signal: params.signal,
          },
          "validator",
        );
        // Missing validation must never remove a high-risk finding.
        if (verdict?.confirmed === false) {
          dropped.add(`${candidate.reportIndex}:${candidate.findingIndex}`);
        }
      } catch (error) {
        if (!params.signal?.aborted) {
          logWarn("review_validation_failed_open", {
            reviewer: params.reports[candidate.reportIndex]?.reviewer,
            session_role: "validator",
            severity: candidate.finding.severity,
            file: candidate.finding.file,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        await session?.dispose();
      }
    }
  });
  await Promise.all(workers);

  recordReviewMetric({
    kind: "validation_stage_completed",
    candidateCount: candidates.length,
    truncatedCandidates,
    droppedCount: dropped.size,
    durationMs: Date.now() - startedAt,
  });

  return {
    reports: params.reports.map((report, reportIndex) => ({
      ...report,
      findings: report.findings.filter(
        (_finding, findingIndex) => !dropped.has(`${reportIndex}:${findingIndex}`),
      ),
    })),
    truncatedCandidates,
  };
}

export function buildSynthesisContext(params: {
  reports: readonly ReviewerReport[];
  failed: readonly ReviewerId[];
  omitted?: readonly ReviewerId[];
  validationTruncatedCandidates?: number;
}): string {
  const compactReports = params.reports.map((report) => ({
    ...report,
    findings: report.findings.map(compactFindingForSynthesis),
  }));
  const degradedCoverage = buildDegradedCoverage(params);
  const instruction =
    "Synthesize these independent Reviewer reports into one ReviewPayload. Use tools only to resolve concrete conflicts or unvalidated high-risk claims. Merge semantic duplicates, reject unsupported claims, do not re-sweep the full diff for new findings, and call submitReview exactly once.";
  const fixedContext = [degradedCoverage, instruction].join("\n\n");
  const reportBlockBudget = REVIEW_SYNTHESIS_CONTEXT_MAX_CHARS - fixedContext.length - 4;
  const reviewerReports = buildBudgetedReviewerReports(compactReports, reportBlockBudget);
  return [reviewerReports, degradedCoverage, instruction].join("\n\n");
}

function highRiskRank(severity: ReviewerReport["findings"][number]["severity"]): number {
  return severity === "P0" || severity === "P1" ? 0 : 1;
}

function truncateForSynthesis(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactFindingForSynthesis(
  finding: ReviewerReport["findings"][number],
): ReviewerReport["findings"][number] {
  if (finding.severity === "P0" || finding.severity === "P1") return finding;
  const { suggestedCode: _suggestedCode, fixPrompt: _fixPrompt, ...rest } = finding;
  return {
    ...rest,
    detail: truncateForSynthesis(finding.detail, REVIEW_SYNTHESIS_LOW_SEVERITY_DETAIL_MAX_CHARS),
    evidence: truncateForSynthesis(
      finding.evidence,
      REVIEW_SYNTHESIS_LOW_SEVERITY_EVIDENCE_MAX_CHARS,
    ),
  };
}

function buildDegradedCoverage(params: {
  failed: readonly ReviewerId[];
  omitted?: readonly ReviewerId[];
  validationTruncatedCandidates?: number;
}): string {
  const reasons: string[] = [];
  if (params.failed.length > 0) {
    reasons.push(`Unavailable reviewers: ${params.failed.join(", ")}`);
  }
  if ((params.omitted?.length ?? 0) > 0) {
    reasons.push(
      `Omitted by Review budget tier policy (not a failure): ${params.omitted?.join(", ")}`,
    );
  }
  if ((params.validationTruncatedCandidates ?? 0) > 0) {
    reasons.push(
      `High-risk validation truncated: ${params.validationTruncatedCandidates} candidate(s) were kept unvalidated.`,
    );
  }
  return `<degraded_coverage>${reasons.length > 0 ? reasons.join(" ") : "none"}</degraded_coverage>`;
}

function buildBudgetedReviewerReports(
  reports: readonly ReviewerReport[],
  maxChars: number,
): string {
  const full = wrapUntrustedBlock(
    "reviewer_reports",
    JSON.stringify({ reports, truncated: false }),
  );
  if (full.length <= maxChars) return full;

  const prioritizedFindings = reports
    .flatMap((report, reportIndex) =>
      report.findings.map((finding, findingIndex) => ({
        reportIndex,
        findingIndex,
        finding,
      })),
    )
    .toSorted(
      (a, b) =>
        highRiskRank(a.finding.severity) - highRiskRank(b.finding.severity) ||
        a.reportIndex - b.reportIndex ||
        a.findingIndex - b.findingIndex,
    );
  const buildCandidate = (findingCount: number): string => {
    const selected = new Set(
      prioritizedFindings
        .slice(0, findingCount)
        .map(({ reportIndex, findingIndex }) => `${reportIndex}:${findingIndex}`),
    );
    const budgetedReports = reports.map((report, reportIndex) => ({
      reviewer: report.reviewer,
      coverage: report.coverage,
      findings: report.findings.filter((_finding, findingIndex) =>
        selected.has(`${reportIndex}:${findingIndex}`),
      ),
      residualRisks: [],
      testingGaps: [],
    }));
    return wrapUntrustedBlock(
      "reviewer_reports",
      JSON.stringify({
        reports: budgetedReports,
        truncated: true,
        omittedFindings: prioritizedFindings.length - findingCount,
        note: "[reviewer reports truncated for synthesis budget]",
      }),
    );
  };

  let low = 0;
  let high = prioritizedFindings.length;
  let best = buildCandidate(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildCandidate(middle);
    if (candidate.length <= maxChars) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}
