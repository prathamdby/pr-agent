import { isAppError } from "../errors/appError.ts";
import type {
  LocalPrWorkspaceCheckoutMode,
  WorkspaceGitDiagnostics,
  WorkspaceGitFailureKind,
  WorkspaceGitTimeoutSource,
} from "./repositoryReader.ts";

export type WorkspaceCheckoutMode =
  | LocalPrWorkspaceCheckoutMode
  | "sparse_fallback"
  | "full_fallback";

export type WorkspaceFallbackReason =
  | "fetch_timeout"
  | "fetch_too_large"
  | "git_failed"
  | "git_low_speed"
  | "unrepresentable_path";

export type WorkspaceFetchAttempt = {
  readonly checkoutMode: LocalPrWorkspaceCheckoutMode;
  readonly outcome: "succeeded" | "failed";
  readonly errorCode: string | null;
  readonly failureKind: WorkspaceGitFailureKind | null;
  readonly timeoutSource: WorkspaceGitTimeoutSource | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killed: boolean;
  readonly elapsedMs: number | null;
  readonly stderr: string | null;
};

export type WorkspaceCheckoutTelemetry = {
  readonly mode: WorkspaceCheckoutMode;
  readonly fallbackReason: WorkspaceFallbackReason | null;
  readonly fetchAttempts: readonly WorkspaceFetchAttempt[];
};

export type WorkspaceCheckoutProperties = Readonly<
  Record<string, string | number | boolean | null>
>;

export function succeededFetchAttempt(
  checkoutMode: LocalPrWorkspaceCheckoutMode,
  diagnostics: WorkspaceGitDiagnostics,
) {
  return ((pinnedReturn: WorkspaceFetchAttempt) => pinnedReturn)({
    checkoutMode,
    outcome: "succeeded",
    errorCode: null,
    failureKind: null,
    timeoutSource: null,
    exitCode: diagnostics.exitCode,
    signal: diagnostics.signal,
    killed: diagnostics.killed,
    elapsedMs: diagnostics.elapsedMs,
    stderr: null,
  });
}

function contextString(context: Record<string, unknown>, key: string) {
  const value = context[key];
  return ((pinnedReturn: string | null) => pinnedReturn)(typeof value === "string" ? value : null);
}

function contextNumber(context: Record<string, unknown>, key: string) {
  const value = context[key];
  return ((pinnedReturn: number | null) => pinnedReturn)(
    typeof value === "number" && Number.isFinite(value) ? value : null,
  );
}

function failureKindOf(value: string | null) {
  return ((pinnedReturn: WorkspaceGitFailureKind | null) => pinnedReturn)(
    value === "timeout" || value === "auth" || value === "missing_ref" || value === "git"
      ? value
      : null,
  );
}

function timeoutSourceOf(value: string | null) {
  return ((pinnedReturn: WorkspaceGitTimeoutSource | null) => pinnedReturn)(
    value === "process_timer" || value === "git_low_speed" ? value : null,
  );
}

export function failedFetchAttempt(checkoutMode: LocalPrWorkspaceCheckoutMode, error: unknown) {
  const context = isAppError(error) ? error.context : {};
  return ((pinnedReturn: WorkspaceFetchAttempt) => pinnedReturn)({
    checkoutMode,
    outcome: "failed",
    errorCode: isAppError(error) ? error.code : null,
    failureKind: failureKindOf(contextString(context, "failureKind")),
    timeoutSource: timeoutSourceOf(contextString(context, "timeoutSource")),
    exitCode: contextNumber(context, "exitCode"),
    signal: contextString(context, "signal"),
    killed: context.killed === true,
    elapsedMs: contextNumber(context, "elapsedMs"),
    stderr: contextString(context, "stderr"),
  });
}

function attemptProperties(prefix: string, attempt: WorkspaceFetchAttempt) {
  return ((pinnedReturn: Record<string, string | number | boolean | null>) => pinnedReturn)({
    [`${prefix}git_operation`]: "fetch",
    [`${prefix}git_checkout_mode`]: attempt.checkoutMode,
    [`${prefix}git_outcome`]: attempt.outcome,
    [`${prefix}git_error_code`]: attempt.errorCode,
    [`${prefix}git_error_kind`]: attempt.failureKind,
    [`${prefix}git_exit_code`]: attempt.exitCode,
    [`${prefix}git_signal`]: attempt.signal,
    [`${prefix}git_killed`]: attempt.killed,
    [`${prefix}git_timeout_source`]: attempt.timeoutSource,
    [`${prefix}git_elapsed_ms`]: attempt.elapsedMs,
  });
}

export function workspaceCheckoutProperties(input: {
  readonly telemetry: WorkspaceCheckoutTelemetry;
  readonly reused: boolean;
}) {
  const { telemetry, reused } = input;
  const attempts = telemetry.fetchAttempts;
  const last = attempts.at(-1);
  const fallback = attempts.length > 1 ? attempts[0] : undefined;
  return ((pinnedReturn: WorkspaceCheckoutProperties) => pinnedReturn)({
    workspace_checkout_mode: telemetry.mode,
    workspace_fallback_reason: telemetry.fallbackReason,
    workspace_checkout_reused: reused,
    workspace_fetch_attempts: attempts.length,
    ...(last != null ? attemptProperties("", last) : {}),
    ...(fallback != null ? attemptProperties("fallback_", fallback) : {}),
  });
}
