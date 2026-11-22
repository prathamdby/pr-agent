import { type Config } from "../../settings/index.ts";
import type { AgentEventsContext } from "../../agent/runtime/agentEventSink.ts";
import { emitWorkSpan, safeEmitEvidenceRejectEvent } from "../../agent/runtime/agentEventSink.ts";
import { specialistSpanFromContext } from "../../analytics/workSpan.ts";
import type { CheckoutCoverage } from "../../prWorkspace/repositoryReader.ts";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.ts";
import { specialistReportSchema, type SpecialistReport } from "./specialistReport.ts";
import { testsFindingError } from "./testsEvidence.ts";
import type { SpecialistId } from "./orchestratorTypes.ts";
import type { EvidenceLedger } from "../findings/evidenceLedger.ts";
import { assertFindingsHaveEvidence } from "../findings/evidenceValidator.ts";
import { parseToolInput } from "../../agent/tools/parseToolInput.ts";
import { buildSubmitFindingsReportPiTool } from "./specialistTools.ts";
import { automatedQualitySystemPrompt } from "../../prompts/quality/prompt.ts";
import { automatedReviewTestsSystemPrompt } from "../../prompts/tests/prompt.ts";
import { automatedSecuritySystemPrompt } from "../../prompts/security/prompt.ts";
import { buildAutomatedSystemPrompt } from "../../prompts/correctness/prompt.ts";
import { specialistSharedPrefix } from "../../prompts/shared/prefix.ts";

export type RunSpecialistParams = {
  readonly cfg: Config;
  readonly cwd: string;
  readonly specialist: SpecialistId;
  readonly agentEvents?: AgentEventsContext;
};

export type SubmissionState = {
  report: SpecialistReport | null;
  validationError: string | null;
};

function emitSpecialistStage(
  params: RunSpecialistParams,
  input: Omit<Parameters<typeof specialistSpanFromContext>[0], "context" | "specialistId">,
) {
  if (!params.agentEvents) return;
  emitWorkSpan(
    params.agentEvents,
    params.cfg,
    specialistSpanFromContext({
      ...input,
      context: params.agentEvents,
      specialistId: params.specialist,
    }),
  );
}

export function buildSubmitTool(
  state: SubmissionState,
  params: RunSpecialistParams,
  evidence?: {
    readonly ledger: EvidenceLedger;
    readonly headSha: string;
    readonly checkoutCoverage?: CheckoutCoverage;
    readonly isPathInCheckout?: (path: string) => boolean;
    readonly specialist: SpecialistId;
    readonly agentEvents?: AgentEventsContext;
    readonly cfg: Config;
  },
) {
  const piTool = buildSubmitFindingsReportPiTool();
  let evidenceFeedbackSent = false;
  const executor: AgentRunnerToolExecutor = async (args) => {
    const schemaStartedAt = Date.now();
    const parsed = parseToolInput(specialistReportSchema, args, {
      toolName: "submit_findings_report",
      errorTitle: "SpecialistReport validation failed:",
    });
    emitSpecialistStage(params, {
      stage: "schema",
      outcome: parsed.ok ? "accepted" : "rejected",
      latencyMs: Date.now() - schemaStartedAt,
      ...(!parsed.ok ? { errorReason: "review.specialist_invalid_report" } : {}),
    });
    if (!parsed.ok) {
      state.validationError = parsed.error;
      return { accepted: false, error: state.validationError };
    }

    const testsError = testsFindingError({
      specialist: params.specialist,
      findings: parsed.value.findings,
      cwd: params.cwd,
      ledger: evidence?.ledger,
      requireContentRead: params.cfg.review.testsEvidence,
    });
    if (testsError != null) {
      state.validationError = testsError;
      return { accepted: false, error: testsError };
    }

    let report = parsed.value;
    if (evidence != null && report.findings.length > 0) {
      const validationStartedAt = Date.now();
      const filtered = assertFindingsHaveEvidence(
        report.findings,
        evidence.ledger,
        evidence.headSha,
        {
          checkoutCoverage: evidence.checkoutCoverage,
          isPathInCheckout: evidence.isPathInCheckout,
        },
      );
      emitSpecialistStage(params, {
        stage: "validation",
        outcome: filtered.rejected.length > 0 ? "rejected" : "accepted",
        latencyMs: Date.now() - validationStartedAt,
        submittedCount: report.findings.length,
        acceptedCount: filtered.accepted.length,
        rejectedCount: filtered.rejected.length,
        ...(filtered.rejected.length > 0
          ? { errorReason: filtered.rejected[0]?.reasonCode ?? "no_evidence" }
          : {}),
      });
      if (filtered.rejected.length > 0 && evidence.agentEvents) {
        safeEmitEvidenceRejectEvent(evidence.agentEvents, evidence.cfg, {
          specialist: evidence.specialist,
          phase: "specialist",
          rejectedCount: filtered.rejected.length,
          reasonCode: filtered.rejected[0]?.reasonCode ?? "no_evidence",
        });
      }
      const findings = filtered.accepted;
      const status =
        report.status === "findings" && findings.length === 0 ? "no_findings" : report.status;
      report = { ...report, status, findings };
      if (filtered.rejected.length > 0 && !evidenceFeedbackSent) {
        evidenceFeedbackSent = true;
        state.validationError =
          "These findings cite lines that no file read or diff result in this session returned, so they were dropped. To keep a dropped finding, read the cited lines, then call submit_findings_report again with the complete report. If the lines do not support it, leave it out.";
        return {
          accepted: false,
          recorded: { findings: findings.length },
          droppedFindings: filtered.rejected.map((entry) => ({
            title: entry.finding.title,
            file: entry.finding.file,
            startLine: entry.finding.startLine,
            endLine: entry.finding.endLine,
            reasonCode: entry.reasonCode,
          })),
          error: state.validationError,
        };
      }
    }

    state.report = report;
    state.validationError = null;
    return { accepted: true };
  };
  return ((pinnedReturn: {
    readonly piTool: ReturnType<typeof buildSubmitFindingsReportPiTool>;
    readonly executor: AgentRunnerToolExecutor;
  }) => pinnedReturn)({ piTool, executor });
}

export const SPECIALIST_SYSTEM_PROMPTS = {
  correctness: buildAutomatedSystemPrompt(),
  security: automatedSecuritySystemPrompt,
  quality: automatedQualitySystemPrompt,
  tests: automatedReviewTestsSystemPrompt,
} satisfies Readonly<Record<SpecialistId, string>>;

function specialistLensBody(systemPrompt: string) {
  const withoutHead = systemPrompt.startsWith(`${specialistSharedPrefix}\n`)
    ? systemPrompt.slice(specialistSharedPrefix.length)
    : systemPrompt;
  return ((pinnedReturn: string) => pinnedReturn)(withoutHead.replace(/^\n+/, ""));
}

export const SPECIALIST_LENS_BODIES = {
  correctness: specialistLensBody(SPECIALIST_SYSTEM_PROMPTS.correctness),
  security: specialistLensBody(SPECIALIST_SYSTEM_PROMPTS.security),
  quality: specialistLensBody(SPECIALIST_SYSTEM_PROMPTS.quality),
  tests: specialistLensBody(SPECIALIST_SYSTEM_PROMPTS.tests),
} satisfies Readonly<Record<SpecialistId, string>>;
