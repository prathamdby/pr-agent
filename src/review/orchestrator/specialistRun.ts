import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import {
  classifyProviderError,
  type ProviderErrorKind,
} from "../../agent/providers/providerErrors.js";
import { resolveAgentRunnerProvider } from "../../agent/providers/index.js";
import type {
  AgentRunnerSession,
  AgentRunnerToolExecutor,
  AgentRunnerTurn,
} from "../../agent/providers/interface.js";
import { runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import { MAX_TOOL_ROUNDS, VALIDATION_REPAIR_ROUNDS } from "../../settings/index.js";
import { specialistSystemPrompt } from "./prompts/specialistPersonas.js";
import { specialistReportSchema, type SpecialistReport } from "./specialistReport.js";
import type { SpecialistId, SpecialistOutcome } from "./orchestratorTypes.js";

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

export type RunSpecialistParams = {
  readonly cfg: Config;
  readonly cwd: string;
  readonly specialist: SpecialistId;
  readonly briefMessage: string;
  readonly workspaceTools: WorkspaceTools;
  readonly timeoutMs: number;
  readonly shouldContinue: () => boolean;
  readonly signal?: AbortSignal;
};

type SubmissionState = {
  report: SpecialistReport | null;
  validationError: string | null;
};

function timeoutError(): Error {
  return new Error("Specialist timeout deadline exceeded");
}

function externalAbortError(): Error {
  return new Error("Specialist run aborted by external signal");
}

function stoppedError(): Error {
  return new Error("Specialist run stopped before completion");
}

function assertCanContinue(params: RunSpecialistParams, deadlineMs: number): void {
  if (params.signal?.aborted) throw externalAbortError();
  if (!params.shouldContinue()) throw stoppedError();
  if (Date.now() >= deadlineMs) throw timeoutError();
}

function canContinue(params: RunSpecialistParams, deadlineMs: number): boolean {
  return !params.signal?.aborted && params.shouldContinue() && Date.now() < deadlineMs;
}

async function waitBeforeStage(
  delayMs: number,
  params: RunSpecialistParams,
  deadlineMs: number,
): Promise<void> {
  assertCanContinue(params, deadlineMs);
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
  assertCanContinue(params, deadlineMs);
}

function formatValidationError(error: z.ZodError): string {
  return [
    "SpecialistReport validation failed:",
    ...error.issues.map(
      (issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    ),
  ].join("\n");
}

function buildSubmitTool(state: SubmissionState): {
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
    state.report = parsed.data;
    state.validationError = null;
    return { accepted: true };
  };
  return { piTool, executor };
}

async function runWithinDeadline<T>(params: {
  readonly run: () => Promise<T>;
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
}): Promise<T> {
  const remainingMs = params.deadlineMs - Date.now();
  if (remainingMs <= 0) throw timeoutError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), remainingMs);
    onExternalAbort = () => reject(externalAbortError());
    params.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (params.signal?.aborted) onExternalAbort();
  });

  try {
    return await Promise.race([params.run(), cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onExternalAbort) params.signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function createSessionWithinDeadline(
  params: RunSpecialistParams,
  deadlineMs: number,
  submitTool: ReturnType<typeof buildSubmitTool>,
): Promise<AgentRunnerSession> {
  const creation = resolveAgentRunnerProvider(params.cfg).createSession({
    cfg: params.cfg,
    cwd: params.cwd,
    systemPrompt: specialistSystemPrompt(params.specialist),
    tools: [...params.workspaceTools.piTools, submitTool.piTool],
    executors: {
      ...params.workspaceTools.executors,
      [SUBMIT_TOOL_NAME]: submitTool.executor,
    },
  });
  let accepted = false;

  try {
    const session = await runWithinDeadline({
      run: () => creation,
      signal: params.signal,
      deadlineMs,
    });
    accepted = true;
    return session;
  } finally {
    if (!accepted) {
      void creation
        .then(async (session) => {
          try {
            await session.abort();
          } finally {
            await session.dispose();
          }
        })
        .catch(() => undefined);
    }
  }
}

async function runAttempt(
  params: RunSpecialistParams,
  deadlineMs: number,
): Promise<SpecialistReport> {
  assertCanContinue(params, deadlineMs);
  const state: SubmissionState = { report: null, validationError: null };
  const submitTool = buildSubmitTool(state);
  const session = await createSessionWithinDeadline(params, deadlineMs, submitTool);

  const send = (
    activeSession: AgentRunnerSession,
    prompt: string,
    opts?: { readonly maxToolRounds?: number },
  ): Promise<AgentRunnerTurn> =>
    runWithinDeadline({
      run: () => activeSession.send(prompt, opts),
      signal: params.signal,
      deadlineMs,
    });

  try {
    assertCanContinue(params, deadlineMs);
    await send(session, params.briefMessage, { maxToolRounds: MAX_TOOL_ROUNDS });

    if (!state.report) {
      state.validationError ??= MISSING_REPORT_ERROR;
      assertCanContinue(params, deadlineMs);
      await runValidationRepairLoop({
        rounds: VALIDATION_REPAIR_ROUNDS,
        shouldContinue: () => canContinue(params, deadlineMs) && state.report === null,
        getValidationError: () => state.validationError,
        clearValidationError: () => {
          state.validationError = null;
        },
        repair: async (validationError) => {
          assertCanContinue(params, deadlineMs);
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
      assertCanContinue(params, deadlineMs);
      throw new Error(state.validationError ?? "Specialist did not submit a valid report");
    }
    return state.report;
  } catch (error) {
    if (params.signal?.aborted || classifyProviderError(error) === "timeout") {
      await session.abort().catch(() => undefined);
    }
    throw error;
  } finally {
    await session.dispose();
  }
}

function retryBackoffMs(attempts: number): number {
  return RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

function failureOutcome(params: {
  readonly specialist: SpecialistId;
  readonly startedAtMs: number;
  readonly attempts: number;
  readonly classification: ProviderErrorKind;
  readonly cause: unknown;
}): SpecialistOutcome {
  return {
    kind: "error",
    specialist: params.specialist,
    durationMs: Date.now() - params.startedAtMs,
    error: new AppError({
      code: "review.specialist_failed",
      message: `${params.specialist} specialist failed after ${params.attempts} attempt(s)`,
      context: {
        specialist: params.specialist,
        classification: params.classification,
        attempts: params.attempts,
      },
      cause: params.cause,
    }),
  };
}

export async function runSpecialist(params: RunSpecialistParams): Promise<SpecialistOutcome> {
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + params.timeoutMs;
  let attempts = 0;
  let ordinaryRetryUsed = false;
  let lastError: unknown = new Error("Specialist did not start");
  let classification: ProviderErrorKind = "unknown";

  try {
    const jitterMs = Math.floor(Math.random() * INITIAL_JITTER_MAX_MS);
    await waitBeforeStage(jitterMs, params, deadlineMs);
  } catch (error) {
    lastError = error;
    classification = classifyProviderError(error);
    return failureOutcome({
      specialist: params.specialist,
      startedAtMs,
      attempts,
      classification,
      cause: lastError,
    });
  }

  while (attempts < MAX_SESSION_ATTEMPTS) {
    try {
      assertCanContinue(params, deadlineMs);
      attempts += 1;
      const report = await runAttempt(params, deadlineMs);
      const durationMs = Date.now() - startedAtMs;
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
        await waitBeforeStage(retryBackoffMs(attempts), params, deadlineMs);
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
  });
}
