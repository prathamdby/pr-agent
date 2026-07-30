import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import type { AgentEventsContext } from "../../agent/runtime/agentEventSink.js";
import { safeEmitEvidenceRejectEvent } from "../../agent/runtime/agentEventSink.js";
import type { CheckoutCoverage } from "../../prWorkspace/localPrWorkspace.js";
import {
  classifyProviderError,
  type ProviderErrorKind,
} from "../../agent/providers/providerErrors.js";
import type { AgentRunnerToolExecutor, AgentRunnerTurn } from "../../agent/providers/interface.js";
import { createFeaturePiSession } from "../../agent/runtime/createFeatureSession.js";
import type { PiSession } from "../../agent/runtime/types.js";
import { runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import { MAX_TOOL_ROUNDS, VALIDATION_REPAIR_ROUNDS } from "../../settings/index.js";
import { recordAgentTurnMetrics } from "../run/reviewRunMetrics.js";
import { specialistSystemPrompt } from "./prompts/specialistPersonas.js";
import { specialistReportSchema, type SpecialistReport } from "./specialistReport.js";
import type { SpecialistId, SpecialistOutcome } from "./orchestratorTypes.js";
import type { EvidenceLedger } from "../findings/evidenceLedger.js";
import { assertFindingsHaveEvidence } from "../findings/evidenceValidator.js";

const MAX_SESSION_ATTEMPTS = 3;
const INITIAL_JITTER_MAX_MS = 3_000;
const RETRY_BACKOFF_BASE_MS = 500;
const SUBMIT_TOOL_NAME = "submit_findings_report";
const MISSING_REPORT_ERROR =
  "No valid SpecialistReport was submitted. Call submit_findings_report with the complete report.";

type WorkspaceTools = {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
};

/** Which wall budget bound this specialist (min of configured timeout and model window). */
export type SpecialistTimeoutBudget = {
  readonly key: "REVIEW_SPECIALIST_TIMEOUT_MS" | "model_window";
  readonly limitMs: number;
};

export type RunSpecialistParams = {
  readonly cfg: Config;
  readonly cwd: string;
  readonly specialist: SpecialistId;
  readonly briefMessage: string;
  readonly workspaceTools: WorkspaceTools;
  readonly timeoutMs: number;
  /** Named binding budget for loud tripwire attribution. Defaults to REVIEW_SPECIALIST_TIMEOUT_MS. */
  readonly timeoutBudget?: SpecialistTimeoutBudget;
  readonly shouldContinue: () => boolean;
  readonly signal?: AbortSignal;
  readonly evidenceLedger?: EvidenceLedger;
  readonly headSha?: string;
  readonly checkoutCoverage?: CheckoutCoverage;
  readonly isPathInCheckout?: (path: string) => boolean;
  readonly agentEvents?: AgentEventsContext;
};

type SubmissionState = {
  report: SpecialistReport | null;
  validationError: string | null;
};

function resolveTimeoutBudget(params: RunSpecialistParams): SpecialistTimeoutBudget {
  if (params.timeoutBudget != null) return params.timeoutBudget;
  return { key: "REVIEW_SPECIALIST_TIMEOUT_MS", limitMs: params.timeoutMs };
}

function timeoutError(params: {
  readonly budget: SpecialistTimeoutBudget;
  readonly startedAtMs: number;
  readonly nowMs?: number;
}): AppError {
  const usedMs = Math.max(0, (params.nowMs ?? Date.now()) - params.startedAtMs);
  return new AppError({
    code: "review.specialist_timeout",
    message: `Specialist timeout deadline exceeded (budget=${params.budget.key} limitMs=${params.budget.limitMs} usedMs=${usedMs})`,
    context: {
      budgetKey: params.budget.key,
      limitMs: params.budget.limitMs,
      usedMs,
    },
  });
}

function externalAbortError(): AppError {
  return new AppError({
    code: "review.specialist_aborted",
    message: "Specialist run aborted by external signal",
  });
}

function assertCanContinue(
  params: RunSpecialistParams,
  deadlineMs: number,
  budget: SpecialistTimeoutBudget,
  startedAtMs: number,
): void {
  if (params.signal?.aborted) throw externalAbortError();
  if (!params.shouldContinue()) {
    throw new AppError({
      code: "review.specialist_stopped",
      message: "Specialist run stopped before completion",
    });
  }
  if (Date.now() >= deadlineMs) {
    throw timeoutError({ budget, startedAtMs });
  }
}

function canContinue(params: RunSpecialistParams, deadlineMs: number): boolean {
  return !params.signal?.aborted && params.shouldContinue() && Date.now() < deadlineMs;
}

async function waitBeforeStage(
  delayMs: number,
  params: RunSpecialistParams,
  deadlineMs: number,
  budget: SpecialistTimeoutBudget,
  startedAtMs: number,
): Promise<void> {
  assertCanContinue(params, deadlineMs, budget, startedAtMs);
  if (delayMs <= 0) return;

  const remainingMs = deadlineMs - Date.now();
  const waitMs = Math.min(delayMs, remainingMs);
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      onAbort = () => {
        clearTimeout(timer);
        reject(externalAbortError());
      };
      params.signal?.addEventListener("abort", onAbort, { once: true });
      if (params.signal?.aborted) onAbort();
    });
  } finally {
    if (onAbort) params.signal?.removeEventListener("abort", onAbort);
  }
  assertCanContinue(params, deadlineMs, budget, startedAtMs);
}

function formatValidationError(error: z.ZodError): string {
  return [
    "SpecialistReport validation failed:",
    ...error.issues.map(
      (issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    ),
  ].join("\n");
}

function buildSubmitTool(
  state: SubmissionState,
  evidence?: {
    readonly ledger: EvidenceLedger;
    readonly headSha: string;
    readonly checkoutCoverage?: CheckoutCoverage;
    readonly isPathInCheckout?: (path: string) => boolean;
    readonly specialist: SpecialistId;
    readonly agentEvents?: AgentEventsContext;
    readonly cfg: Config;
  },
): {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
} {
  const piTool: PiTool = {
    name: SUBMIT_TOOL_NAME,
    description: "Submit the specialist's final findings report exactly once.",
    parameters: z.toJSONSchema(specialistReportSchema),
  };
  const executor: AgentRunnerToolExecutor = async (args) => {
    const parsed = specialistReportSchema.safeParse(args);
    if (!parsed.success) {
      state.validationError = formatValidationError(parsed.error);
      return { accepted: false, error: state.validationError };
    }

    let report = parsed.data;
    if (evidence != null && report.findings.length > 0) {
      const filtered = assertFindingsHaveEvidence(
        report.findings,
        evidence.ledger,
        evidence.headSha,
        {
          checkoutCoverage: evidence.checkoutCoverage,
          isPathInCheckout: evidence.isPathInCheckout,
        },
      );
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
    }

    state.report = report;
    state.validationError = null;
    return { accepted: true };
  };
  return { piTool, executor };
}

async function runWithinDeadline<T>(params: {
  readonly run: () => Promise<T>;
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
  readonly budget: SpecialistTimeoutBudget;
  readonly startedAtMs: number;
  readonly cancel?: () => Promise<void>;
  readonly deferCleanup?: () => Promise<void>;
  readonly onCleanupDeferred?: () => void;
}): Promise<T> {
  const remainingMs = params.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw timeoutError({
      budget: params.budget,
      startedAtMs: params.startedAtMs,
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  type OperationResult =
    | { readonly kind: "settled"; readonly value: T }
    | { readonly kind: "rejected"; readonly error: unknown }
    | { readonly kind: "cancelled"; readonly error: Error };
  const cancelled = new Promise<OperationResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          kind: "cancelled",
          error: timeoutError({
            budget: params.budget,
            startedAtMs: params.startedAtMs,
          }),
        }),
      remainingMs,
    );
    onExternalAbort = () => resolve({ kind: "cancelled", error: externalAbortError() });
    params.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (params.signal?.aborted) onExternalAbort();
  });

  const operation = params.run();
  const settled: Promise<OperationResult> = operation.then(
    (value) => ({ kind: "settled", value }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
  try {
    const result = await Promise.race([settled, cancelled]);
    if (result.kind === "settled") return result.value;
    if (result.kind === "rejected") throw result.error;
    const cancel = params.cancel?.();
    if (cancel) void cancel.catch(() => undefined);
    if (params.deferCleanup) {
      params.onCleanupDeferred?.();
      void settled.then(() => params.deferCleanup?.()).catch(() => undefined);
    }
    throw result.error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onExternalAbort) params.signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function createSessionWithinDeadline(
  params: RunSpecialistParams,
  deadlineMs: number,
  budget: SpecialistTimeoutBudget,
  startedAtMs: number,
  submitTool: ReturnType<typeof buildSubmitTool>,
): Promise<PiSession> {
  const creation = createFeaturePiSession({
    role: "specialist",
    cfg: params.cfg,
    cwd: params.cwd,
    systemPrompt: specialistSystemPrompt(params.specialist),
    tools: [...params.workspaceTools.piTools, submitTool.piTool],
    executors: {
      ...params.workspaceTools.executors,
      [SUBMIT_TOOL_NAME]: submitTool.executor,
    },
    // Parallel specialists share session_role "specialist"; skip durability so
    // concurrent checkpoint/snapshot writes cannot overwrite each other.
  });
  return runWithinDeadline({
    run: () => creation,
    signal: params.signal,
    deadlineMs,
    budget,
    startedAtMs,
    deferCleanup: async () => {
      const session = await creation;
      await session.abort().catch(() => undefined);
      await session.dispose().catch(() => undefined);
    },
  });
}

async function runAttempt(
  params: RunSpecialistParams,
  deadlineMs: number,
  budget: SpecialistTimeoutBudget,
  startedAtMs: number,
): Promise<SpecialistReport> {
  assertCanContinue(params, deadlineMs, budget, startedAtMs);
  const state: SubmissionState = { report: null, validationError: null };
  const submitTool = buildSubmitTool(
    state,
    params.evidenceLedger && params.headSha
      ? {
          ledger: params.evidenceLedger,
          headSha: params.headSha,
          checkoutCoverage: params.checkoutCoverage,
          isPathInCheckout: params.isPathInCheckout,
          specialist: params.specialist,
          agentEvents: params.agentEvents,
          cfg: params.cfg,
        }
      : undefined,
  );
  const session = await createSessionWithinDeadline(
    params,
    deadlineMs,
    budget,
    startedAtMs,
    submitTool,
  );
  let cleanupDeferred = false;

  const send = async (
    activeSession: PiSession,
    prompt: string,
    opts?: { readonly maxToolRounds?: number },
  ): Promise<AgentRunnerTurn> => {
    const turn = await runWithinDeadline({
      run: () =>
        activeSession.send(prompt, {
          ...opts,
          phase: "specialist",
          checkpointId: `${activeSession.role}:specialist`,
        }),
      signal: params.signal,
      deadlineMs,
      budget,
      startedAtMs,
      cancel: () => activeSession.abort(),
      deferCleanup: () => activeSession.dispose(),
      onCleanupDeferred: () => {
        cleanupDeferred = true;
      },
    });
    recordAgentTurnMetrics(turn, { specialist: true });
    return turn;
  };

  try {
    assertCanContinue(params, deadlineMs, budget, startedAtMs);
    await send(session, params.briefMessage, { maxToolRounds: MAX_TOOL_ROUNDS });

    if (!state.report) {
      state.validationError ??= MISSING_REPORT_ERROR;
      assertCanContinue(params, deadlineMs, budget, startedAtMs);
      await runValidationRepairLoop({
        rounds: VALIDATION_REPAIR_ROUNDS,
        shouldContinue: () => canContinue(params, deadlineMs) && state.report === null,
        getValidationError: () => state.validationError,
        clearValidationError: () => {
          state.validationError = null;
        },
        repair: async (validationError) => {
          assertCanContinue(params, deadlineMs, budget, startedAtMs);
          await runSubmitOnlyRound(
            session,
            {
              piTools: [submitTool.piTool],
              executors: { [SUBMIT_TOOL_NAME]: submitTool.executor },
            },
            [
              validationError,
              "Fix the report and call submit_findings_report now. Do not use any other tools.",
            ].join("\n\n"),
            (activeSession, prompt) => send(activeSession, prompt),
          );
          if (!state.report && !state.validationError) {
            state.validationError = MISSING_REPORT_ERROR;
          }
        },
      });
    }

    if (!state.report) {
      assertCanContinue(params, deadlineMs, budget, startedAtMs);
      throw new AppError({
        code: "review.specialist_invalid_report",
        message: state.validationError ?? "Specialist did not submit a valid report",
      });
    }
    return state.report;
  } finally {
    if (!cleanupDeferred) {
      await runWithinDeadline({
        run: () => session.dispose(),
        signal: params.signal,
        deadlineMs,
        budget,
        startedAtMs,
        cancel: () => session.abort(),
      });
    }
  }
}

function failureOutcome(params: {
  readonly specialist: SpecialistId;
  readonly startedAtMs: number;
  readonly attempts: number;
  readonly classification: ProviderErrorKind;
  readonly cause: unknown;
  readonly budget?: SpecialistTimeoutBudget;
}): SpecialistOutcome {
  const usedMs = Date.now() - params.startedAtMs;
  const budgetUsedMs = usedMs;
  const budgetContext =
    params.classification === "timeout" && params.budget != null
      ? {
          budgetKey: params.budget.key,
          limitMs: params.budget.limitMs,
          usedMs: budgetUsedMs,
        }
      : {};
  const budgetSuffix =
    params.classification === "timeout" && params.budget != null
      ? ` (budget=${params.budget.key} limitMs=${params.budget.limitMs} usedMs=${budgetUsedMs})`
      : "";
  return {
    kind: "error",
    specialist: params.specialist,
    durationMs: usedMs,
    error: new AppError({
      code: "review.specialist_failed",
      message: `${params.specialist} specialist failed after ${params.attempts} attempt(s)${budgetSuffix}`,
      context: {
        specialist: params.specialist,
        classification: params.classification,
        attempts: params.attempts,
        ...budgetContext,
      },
      cause: params.cause,
    }),
  };
}

export async function runSpecialist(params: RunSpecialistParams): Promise<SpecialistOutcome> {
  const startedAtMs = Date.now();
  const budget = resolveTimeoutBudget(params);
  const deadlineMs = startedAtMs + params.timeoutMs;
  let attempts = 0;
  let ordinaryRetryUsed = false;
  let lastError: unknown = new AppError({
    code: "review.specialist_not_started",
    message: "Specialist did not start",
  });
  let classification: ProviderErrorKind = "unknown";

  try {
    const jitterMs = Math.floor(Math.random() * INITIAL_JITTER_MAX_MS);
    await waitBeforeStage(jitterMs, params, deadlineMs, budget, startedAtMs);
  } catch (error) {
    lastError = error;
    classification = classifyProviderError(error);
    return failureOutcome({
      specialist: params.specialist,
      startedAtMs,
      attempts,
      classification,
      cause: lastError,
      budget,
    });
  }

  while (attempts < MAX_SESSION_ATTEMPTS) {
    try {
      assertCanContinue(params, deadlineMs, budget, startedAtMs);
      attempts += 1;
      const report = await runAttempt(params, deadlineMs, budget, startedAtMs);
      const nowMs = Date.now();
      const durationMs = nowMs - startedAtMs;
      // Defense in depth: never surface empty/report success after the wall budget.
      if (nowMs >= deadlineMs || durationMs > params.timeoutMs) {
        throw timeoutError({ budget, startedAtMs, nowMs });
      }
      if (report.status === "no_findings") {
        return { kind: "empty", specialist: params.specialist, durationMs };
      }
      return {
        kind: "report",
        specialist: params.specialist,
        report: { ...report, status: "findings" },
        durationMs,
      };
    } catch (error) {
      lastError = error;
      classification = classifyProviderError(error);
    }

    if (attempts >= MAX_SESSION_ATTEMPTS || !canContinue(params, deadlineMs)) break;

    if (classification === "rate_limit" || classification === "timeout") {
      try {
        await waitBeforeStage(
          RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
          params,
          deadlineMs,
          budget,
          startedAtMs,
        );
      } catch (error) {
        lastError = error;
        classification = classifyProviderError(error);
        break;
      }
      continue;
    }

    if (ordinaryRetryUsed) break;
    ordinaryRetryUsed = true;
  }

  return failureOutcome({
    specialist: params.specialist,
    startedAtMs,
    attempts,
    classification,
    cause: lastError,
    budget,
  });
}
