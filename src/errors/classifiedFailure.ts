import {
  classifyProviderError,
  type ProviderErrorKind,
} from "../agent/providers/providerErrors.js";
import {
  classifyGithubError,
  looksLikeGithubError,
  type GithubErrorKind,
} from "../github/githubErrors.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { isAppError } from "./appError.js";

export type FailureDomain = "provider" | "github" | "internal" | "unknown";

export type ClassifiedErrorKind =
  | ProviderErrorKind
  | GithubErrorKind
  | "validation"
  | "publish"
  | "cancelled"
  | "superseded"
  | "unknown";

export type ClassifiedFailure = {
  readonly failureDomain: FailureDomain;
  readonly errorKind: ClassifiedErrorKind;
  readonly errorCode?: string;
  readonly errorMessage: string;
  readonly phase?: string;
  readonly toolName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly causeChain?: readonly string[];
  readonly errorCount?: number;
};

export type ClassifyFailureHints = {
  readonly domain?: FailureDomain;
  readonly phase?: string;
  readonly toolName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly lifecycle?: "superseded" | "cancelled" | "stale_head";
  readonly errorCount?: number;
};

const MAX_CAUSE_CHAIN = 5;

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function collectCauseChain(error: unknown): string[] {
  const out: string[] = [];
  let current: unknown = error instanceof Error ? error.cause : undefined;
  while (current != null && out.length < MAX_CAUSE_CHAIN) {
    const msg = sanitizeLogMessage(rawMessage(current));
    if (msg.length > 0) out.push(msg);
    current = current instanceof Error ? current.cause : undefined;
  }
  return out;
}

function walkErrors(error: unknown): unknown[] {
  const out: unknown[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current != null && depth < MAX_CAUSE_CHAIN + 1) {
    out.push(current);
    current = current instanceof Error ? current.cause : undefined;
    depth += 1;
  }
  return out;
}

function classifyFromErrorChain(error: unknown): {
  domain: FailureDomain;
  kind: ClassifiedErrorKind;
} {
  const nodes = walkErrors(error);
  for (const node of nodes) {
    if (looksLikeGithubError(node)) {
      const kind = classifyGithubError(node);
      if (kind !== "unknown") return { domain: "github", kind };
    }
  }
  for (const node of nodes) {
    const kind = classifyProviderError(node);
    if (kind !== "unknown") return { domain: "provider", kind };
  }
  if (isAppError(error)) {
    const code = error.code;
    if (code.startsWith("review.") && /validation/.test(code)) {
      return { domain: "internal", kind: "validation" };
    }
    if (code.startsWith("review.") && /publish/.test(code)) {
      return { domain: "internal", kind: "publish" };
    }
    return { domain: "internal", kind: "unknown" };
  }
  return { domain: "unknown", kind: "unknown" };
}

/**
 * Logs/analytics classification for terminal and soft-fail agent-work paths.
 * Precedence: lifecycle hint → explicit domain hint → GitHub-shaped (incl. cause)
 * → provider → AppError/internal → unknown.
 */
export function classifyFailure(error: unknown, hints?: ClassifyFailureHints): ClassifiedFailure {
  if (hints?.lifecycle === "superseded") {
    return finalize(error, "internal", "superseded", hints);
  }
  if (hints?.lifecycle === "cancelled" || hints?.lifecycle === "stale_head") {
    return finalize(error, "internal", "cancelled", hints);
  }

  if (hints?.domain === "github") {
    return finalize(error, "github", classifyGithubError(error), hints);
  }
  if (hints?.domain === "provider") {
    return finalize(error, "provider", classifyProviderError(error), hints);
  }
  if (hints?.domain === "internal") {
    const fromChain = classifyFromErrorChain(error);
    return finalize(
      error,
      "internal",
      fromChain.domain === "internal" ? fromChain.kind : "unknown",
      hints,
    );
  }

  const classified = classifyFromErrorChain(error);
  return finalize(error, classified.domain, classified.kind, hints);
}

function finalize(
  error: unknown,
  failureDomain: FailureDomain,
  errorKind: ClassifiedErrorKind,
  hints?: ClassifyFailureHints,
): ClassifiedFailure {
  const causeChain = collectCauseChain(error);
  return {
    failureDomain,
    errorKind,
    ...(isAppError(error) ? { errorCode: error.code } : {}),
    errorMessage: sanitizeLogMessage(rawMessage(error)),
    ...(hints?.phase != null ? { phase: hints.phase } : {}),
    ...(hints?.toolName != null ? { toolName: hints.toolName } : {}),
    ...(hints?.provider != null ? { provider: hints.provider } : {}),
    ...(hints?.model != null ? { model: hints.model } : {}),
    ...(causeChain.length > 0 ? { causeChain } : {}),
    ...(hints?.errorCount != null ? { errorCount: hints.errorCount } : {}),
  };
}

export function classifiedFailureLogFields(f: ClassifiedFailure): Record<string, unknown> {
  return {
    failureDomain: f.failureDomain,
    errorKind: f.errorKind,
    errorMessage: f.errorMessage,
    ...(f.errorCode != null ? { errorCode: f.errorCode } : {}),
    ...(f.phase != null ? { phase: f.phase } : {}),
    ...(f.toolName != null ? { toolName: f.toolName } : {}),
    ...(f.provider != null ? { provider: f.provider } : {}),
    ...(f.model != null ? { model: f.model } : {}),
    ...(f.causeChain != null ? { causeChain: f.causeChain } : {}),
    ...(f.errorCount != null ? { errorCount: f.errorCount } : {}),
  };
}

export function classifiedFailurePostHogProperties(f: ClassifiedFailure): Record<string, unknown> {
  return {
    failure_domain: f.failureDomain,
    error_kind: f.errorKind,
    error_message: f.errorMessage,
    ...(f.errorCode != null ? { error_code: f.errorCode } : {}),
    ...(f.phase != null ? { phase: f.phase } : {}),
    ...(f.toolName != null ? { tool_name: f.toolName } : {}),
    ...(f.provider != null ? { provider: f.provider } : {}),
    ...(f.model != null ? { model: f.model } : {}),
    ...(f.causeChain != null ? { cause_chain: f.causeChain } : {}),
    ...(f.errorCount != null ? { error_count: f.errorCount } : {}),
  };
}
