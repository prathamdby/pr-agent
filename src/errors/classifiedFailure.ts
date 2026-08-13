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
import type { JsonObject } from "../util/jsonValue.js";
import { AppError } from "./appError.js";

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

type MutableClassifiedFailure = {
  -readonly [K in keyof ClassifiedFailure]: ClassifiedFailure[K];
};

type ClassifiedFailurePostHogProperties = {
  failure_domain: FailureDomain;
  error_kind: ClassifiedErrorKind;
  error_message: string;
  error_code?: string;
  phase?: string;
  tool_name?: string;
  provider?: string;
  model?: string;
  cause_chain?: readonly string[];
  error_count?: number;
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

function collectCauseChain(error: Error): string[] {
  const out: string[] = [];
  let current = error.cause instanceof Error ? error.cause : undefined;
  while (current !== undefined && out.length < MAX_CAUSE_CHAIN) {
    const msg = sanitizeLogMessage(current.message);
    if (msg.length > 0) out.push(msg);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return out;
}

function walkErrors(error: Error): Error[] {
  const out: Error[] = [];
  let current: Error | undefined = error;
  let depth = 0;
  while (current !== undefined && depth < MAX_CAUSE_CHAIN + 1) {
    out.push(current);
    current = current.cause instanceof Error ? current.cause : undefined;
    depth += 1;
  }
  return out;
}

type ErrorChainClassification = {
  readonly domain: FailureDomain;
  readonly kind: ClassifiedErrorKind;
};

function classifyFromErrorChain(error: Error): ErrorChainClassification {
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
  if (error instanceof AppError) {
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
export function classifyFailure(error: Error, hints?: ClassifyFailureHints): ClassifiedFailure {
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
  error: Error,
  failureDomain: FailureDomain,
  errorKind: ClassifiedErrorKind,
  hints?: ClassifyFailureHints,
): ClassifiedFailure {
  const causeChain = collectCauseChain(error);
  const result: ClassifiedFailure = {
    failureDomain,
    errorKind,
    errorMessage: sanitizeLogMessage(error.message),
  };
  const withCode = error instanceof AppError ? { ...result, errorCode: error.code } : result;
  const withPhase = hints?.phase != null ? { ...withCode, phase: hints.phase } : withCode;
  const withTool = hints?.toolName != null ? { ...withPhase, toolName: hints.toolName } : withPhase;
  const withProvider =
    hints?.provider != null ? { ...withTool, provider: hints.provider } : withTool;
  const withModel = hints?.model != null ? { ...withProvider, model: hints.model } : withProvider;
  const withChain = causeChain.length > 0 ? { ...withModel, causeChain } : withModel;
  return hints?.errorCount != null ? { ...withChain, errorCount: hints.errorCount } : withChain;
}

export function classifiedFailureLogFields(f: ClassifiedFailure): JsonObject {
  const fields: MutableClassifiedFailure = {
    failureDomain: f.failureDomain,
    errorKind: f.errorKind,
    errorMessage: f.errorMessage,
  };
  if (f.errorCode != null) fields.errorCode = f.errorCode;
  if (f.phase != null) fields.phase = f.phase;
  if (f.toolName != null) fields.toolName = f.toolName;
  if (f.provider != null) fields.provider = f.provider;
  if (f.model != null) fields.model = f.model;
  if (f.causeChain != null) fields.causeChain = f.causeChain;
  if (f.errorCount != null) fields.errorCount = f.errorCount;
  return fields;
}

export function classifiedFailurePostHogProperties(f: ClassifiedFailure): JsonObject {
  const fields: ClassifiedFailurePostHogProperties = {
    failure_domain: f.failureDomain,
    error_kind: f.errorKind,
    error_message: f.errorMessage,
  };
  if (f.errorCode != null) fields.error_code = f.errorCode;
  if (f.phase != null) fields.phase = f.phase;
  if (f.toolName != null) fields.tool_name = f.toolName;
  if (f.provider != null) fields.provider = f.provider;
  if (f.model != null) fields.model = f.model;
  if (f.causeChain != null) fields.cause_chain = f.causeChain;
  if (f.errorCount != null) fields.error_count = f.errorCount;
  return fields;
}
