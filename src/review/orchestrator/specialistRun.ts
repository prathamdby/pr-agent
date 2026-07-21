import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import {
  resolveAgentRunnerProvider,
  type AgentRunnerProvider,
} from "../../agent/providers/index.js";
import type {
  AgentRunnerSession,
  AgentRunnerToolExecutor,
} from "../../agent/providers/interface.js";
import { classifyProviderError } from "../../agent/providers/providerErrors.js";
import {
  MAX_SPECIALIST_ATTEMPTS,
  MAX_TOOL_ROUNDS,
  SPECIALIST_TRANSIENT_BACKOFF_MS,
  VALIDATION_REPAIR_ROUNDS,
} from "../../settings/index.js";
import { specialistSystemPrompt } from "./prompts/specialistPersonas.js";
import {
  specialistReportSchema,
  type SpecialistId,
  type SpecialistOutcome,
  type SpecialistReport,
} from "./specialistReport.js";
import { toolAccepted, toolRejected } from "./structuredToolResult.js";

const REPORT_TOOL_NAME = "submit_findings_report";

const REPORT_TOOL_PARAMETERS = z.toJSONSchema(specialistReportSchema, {
  unrepresentable: "any",
}) as PiTool["parameters"];

const SUBMIT_NUDGE =
  'Call submit_findings_report now. Use status "no_findings" if nothing meets your reporting gate.';

/** Terminal reason recorded on a failed specialist outcome's AppError context. */
type SpecialistFailureReason = "superseded" | "deadline" | "attempt_failed";

function formatSpecialistReportError(error: z.ZodError): string {
  const lines = ["submit_findings_report validation failed:"];
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    lines.push(`- ${path}: ${issue.message}`);
  }
  lines.push(
    'Resubmit with status "findings" plus at least one valid finding, or status "no_findings" with no findings.',
  );
  return lines.join("\n");
}

/** Report-capture tool: validates against the canonical schema and stores the parsed report. */
function buildSpecialistReportTool(): {
  piTool: PiTool;
  executor: AgentRunnerToolExecutor;
  getReport: () => SpecialistReport | undefined;
  getLastError: () => string | null;
  clearLastError: () => void;
} {
  let report: SpecialistReport | undefined;
  let lastError: string | null = null;
  const piTool: PiTool = {
    name: REPORT_TOOL_NAME,
    description: [
      "Submit your investigation result exactly once.",
      'Set status "findings" with a non-empty findings array, or status "no_findings" with no findings.',
      "Each finding: severity P0|P1|P2|P3, file, startLine, endLine, title, detail; fixPrompt required for P0/P1/P2.",
    ].join(" "),
    parameters: REPORT_TOOL_PARAMETERS,
  };
  const executor: AgentRunnerToolExecutor = async (args) => {
    const parsed = specialistReportSchema.safeParse(args);
    if (!parsed.success) {
      lastError = formatSpecialistReportError(parsed.error);
      return toolRejected(lastError);
    }
    report = parsed.data;
    lastError = null;
    return toolAccepted(parsed.data);
  };
  return {
    piTool,
    executor,
    getReport: () => report,
    getLastError: () => lastError,
    clearLastError: () => {
      lastError = null;
    },
  };
}

function isTransientFailure(error: unknown): boolean {
  const kind = classifyProviderError(error);
  return kind === "rate_limit" || kind === "timeout";
}

async function withAttemptTimeout(
  work: () => Promise<void>,
  timeoutMs: number,
  specialist: SpecialistId,
  onTimeout: () => void,
): Promise<void> {
  if (timeoutMs <= 0) {
    onTimeout();
    throw new AppError({
      code: "review.specialist_timeout",
      message: `Specialist ${specialist} has no remaining time budget before its deadline`,
      context: { specialist },
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(
        new AppError({
          code: "review.specialist_timeout",
          message: `Specialist ${specialist} timed out after ${timeoutMs}ms`,
          context: { specialist, timeoutMs },
        }),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([work(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run one specialist over the shared read-only checkout: fresh session, persona system
 * prompt, brief as the first user message, structured report tool. Distinguishes findings /
 * explicit-empty / error and never throws. Retries once with a fresh session on a
 * non-transient failure (decision 8) and separately retries classified rate_limit/timeout
 * failures with backoff without consuming that fresh-session retry, capped at
 * `MAX_SPECIALIST_ATTEMPTS` total (decision 24). Respects the caller deadline (decision 17)
 * and cancels via `abort()` on timeout (decision 18).
 */
export async function runSpecialist(args: {
  cfg: Config;
  cwd: string;
  specialist: SpecialistId;
  briefMessage: string;
  workspaceTools: {
    piTools: readonly PiTool[];
    executors: Record<string, AgentRunnerToolExecutor>;
  };
  timeoutMs: number;
  shouldContinue: () => boolean;
  /** Optional hard run deadline (ms epoch): retries only fire while it has not passed. */
  deadlineAtMs?: number;
  /**
   * Optional external cancellation. When it fires mid-attempt the active session is aborted
   * and disposed and no further attempt starts. Phase 4 shares one signal across all
   * specialists to cancel them together on supersede/deadline (decisions 17/18).
   */
  signal?: AbortSignal;
  /** Optional pre-dispatch stagger (ms); the completion pump supplies jitter in Phase 4. */
  startDelayMs?: number;
  /** Injected for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  provider?: AgentRunnerProvider;
}): Promise<SpecialistOutcome> {
  const {
    cfg,
    cwd,
    specialist,
    briefMessage,
    workspaceTools,
    timeoutMs,
    shouldContinue,
    deadlineAtMs,
    startDelayMs = 0,
  } = args;
  const now = args.now ?? Date.now;
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const provider = args.provider ?? resolveAgentRunnerProvider(cfg);
  const signal = args.signal;
  const startedAt = now();

  const aborted = (): boolean => signal?.aborted === true;

  const failure = (reason: SpecialistFailureReason, cause?: unknown): SpecialistOutcome => ({
    specialist,
    kind: "error",
    error: new AppError({
      code: "review.specialist_failed",
      message: `Specialist ${specialist} did not complete (${reason})`,
      context: { specialist, reason },
      ...(cause !== undefined ? { cause } : {}),
    }),
    durationMs: now() - startedAt,
  });

  const deadlinePassed = (): boolean => deadlineAtMs !== undefined && now() >= deadlineAtMs;

  const runOneAttempt = async (attemptTimeoutMs: number): Promise<SpecialistReport> => {
    const reportTool = buildSpecialistReportTool();
    const session: AgentRunnerSession = await provider.createSession({
      cfg,
      cwd,
      systemPrompt: specialistSystemPrompt(specialist),
      tools: [...workspaceTools.piTools, reportTool.piTool],
      executors: { ...workspaceTools.executors, [REPORT_TOOL_NAME]: reportTool.executor },
    });
    const onExternalAbort = (): void => session.abort();
    if (signal !== undefined) {
      if (signal.aborted) session.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      await withAttemptTimeout(
        async () => {
          await session.send(briefMessage, { maxToolRounds: MAX_TOOL_ROUNDS });
          if (reportTool.getReport() !== undefined) return;
          await runValidationRepairLoop({
            rounds: VALIDATION_REPAIR_ROUNDS,
            shouldContinue: () => reportTool.getReport() === undefined && shouldContinue(),
            getValidationError: () =>
              reportTool.getReport() !== undefined
                ? null
                : (reportTool.getLastError() ?? SUBMIT_NUDGE),
            clearValidationError: () => reportTool.clearLastError(),
            repair: async (validationError) => {
              await runSubmitOnlyRound(
                session,
                {
                  piTools: [reportTool.piTool],
                  executors: { [REPORT_TOOL_NAME]: reportTool.executor },
                },
                validationError,
              );
            },
          });
        },
        attemptTimeoutMs,
        specialist,
        () => session.abort(),
      );
      const report = reportTool.getReport();
      if (report === undefined) {
        throw new AppError({
          code: "review.specialist_report_missing",
          message: `Specialist ${specialist} exhausted validation repair without a report`,
          context: { specialist },
        });
      }
      return report;
    } finally {
      if (signal !== undefined) signal.removeEventListener("abort", onExternalAbort);
      await session.dispose();
    }
  };

  if (aborted() || !shouldContinue()) return failure("superseded");
  if (deadlinePassed()) return failure("deadline");
  if (startDelayMs > 0) await sleep(startDelayMs);

  let freshRetryUsed = false;
  let transientRetries = 0;
  let attempts = 0;
  let lastFailure: unknown;

  while (attempts < MAX_SPECIALIST_ATTEMPTS) {
    if (aborted() || !shouldContinue()) return failure("superseded", lastFailure);
    if (deadlinePassed()) return failure("deadline", lastFailure);
    const remainingMs =
      deadlineAtMs !== undefined ? Math.min(timeoutMs, deadlineAtMs - now()) : timeoutMs;
    attempts += 1;
    try {
      const report = await runOneAttempt(remainingMs);
      switch (report.status) {
        case "no_findings":
          return { specialist, kind: "empty", durationMs: now() - startedAt };
        case "findings":
          return {
            specialist,
            kind: "report",
            report: { ...report, status: "findings" },
            durationMs: now() - startedAt,
          };
        default: {
          const exhaustive: never = report.status;
          return exhaustive;
        }
      }
    } catch (error) {
      lastFailure = error;
      if (aborted() || !shouldContinue()) return failure("superseded", error);
      if (attempts >= MAX_SPECIALIST_ATTEMPTS) break;
      if (deadlinePassed()) return failure("deadline", error);
      if (isTransientFailure(error)) {
        const backoffMs =
          SPECIALIST_TRANSIENT_BACKOFF_MS[
            Math.min(transientRetries, SPECIALIST_TRANSIENT_BACKOFF_MS.length - 1)
          ];
        transientRetries += 1;
        // Never sleep past the hard deadline: if the backoff would consume the remaining
        // budget there is no time to run another attempt, so fail with deadline now
        // rather than dispatching a session that cannot finish (decision 17).
        if (deadlineAtMs !== undefined && deadlineAtMs - now() <= backoffMs) {
          return failure("deadline", error);
        }
        await sleep(backoffMs);
        continue;
      }
      if (!freshRetryUsed) {
        freshRetryUsed = true;
        continue;
      }
      break;
    }
  }

  return failure("attempt_failed", lastFailure);
}
