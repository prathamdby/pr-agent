import {
  classifyProviderError,
  isCancelAbortError,
  type ProviderErrorKind,
} from "../agent/providers/providerErrors.js";
import {
  classifyGithubError,
  githubRequestPath,
  looksLikeGithubError,
  type GithubErrorKind,
} from "../github/githubErrors.js";
import { allowlistedHttpStatus, httpStatus } from "../github/httpStatus.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { isAppError } from "./appError.js";
import type { AppErrorDomain, AppErrorKind } from "./appErrorCodes.js";

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
  readonly httpStatus?: number;
  readonly requestPath?: string;
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
  return walkErrors(error)
    .slice(1)
    .map((cause) => sanitizeLogMessage(rawMessage(cause)))
    .filter((message) => message.length > 0);
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

type InternalErrorKind = Extract<ClassifiedErrorKind, "validation" | "publish">;

const INTERNAL_ERROR_KIND: {
  readonly [D in AppErrorDomain]?: { readonly [K in AppErrorKind<D>]?: InternalErrorKind };
} = {
  operation_intent: {
    mutation_outcome_unknown: "publish",
  },
  review: {
    declare_duplicate_validation_failed: "validation",
    deterministic_finding_publish_failed: "publish",
    publish_summary_failed: "publish",
    publish_summary_semantic_validation_failed: "validation",
    publish_summary_validation_failed: "validation",
    publish_thread_failed: "publish",
    publish_thread_overlap_unanswered: "publish",
    publish_thread_source_required: "publish",
    publish_thread_validation_failed: "validation",
  },
};

function classifyFromErrorChain(error: unknown): {
  domain: FailureDomain;
  kind: ClassifiedErrorKind;
} {
  const nodes = walkErrors(error);
  for (const node of nodes) {
    if (isCancelAbortError(node)) return { domain: "internal", kind: "cancelled" };
    if (!isAppError(node)) continue;
    if (node.domain === "provider") {
      return { domain: "provider", kind: classifyProviderError(node) };
    }
    if (node.domain === "github") {
      return { domain: "github", kind: classifyGithubError(node) };
    }
    const byKind: Partial<Record<string, InternalErrorKind>> | undefined =
      INTERNAL_ERROR_KIND[node.domain];
    const kind = byKind?.[node.kind];
    if (node.domain === "operation_intent" && kind != null) {
      return { domain: "internal", kind };
    }
  }
  for (const node of nodes) {
    if (looksLikeGithubError(node)) {
      const kind = classifyGithubError(node);
      if (kind !== "unknown") return { domain: "github", kind };
    }
  }
  for (const node of nodes) {
    const kind = classifyProviderError(node);
    if (kind !== "unknown") {
      return { domain: isAppError(node) ? "internal" : "provider", kind };
    }
  }
  const appError = nodes.find(isAppError);
  if (appError != null) {
    const byKind: Partial<Record<string, InternalErrorKind>> | undefined =
      INTERNAL_ERROR_KIND[appError.domain];
    return { domain: "internal", kind: byKind?.[appError.kind] ?? "unknown" };
  }
  return { domain: "unknown", kind: "unknown" };
}

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
    const kind = classifyProviderError(error);
    return finalize(
      error,
      "provider",
      kind === "unknown" && isAppError(error) ? classifyProviderError(rawMessage(error)) : kind,
      hints,
    );
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

function githubHttpFields(error: unknown): {
  readonly httpStatus?: number;
  readonly requestPath?: string;
} {
  for (const node of walkErrors(error)) {
    if (!looksLikeGithubError(node)) continue;
    const status = allowlistedHttpStatus(httpStatus(node));
    const requestPath = githubRequestPath(node);
    if (status == null && requestPath == null) continue;
    return {
      ...(status != null ? { httpStatus: status } : {}),
      ...(requestPath != null ? { requestPath } : {}),
    };
  }
  return {};
}

function finalize(
  error: unknown,
  failureDomain: FailureDomain,
  errorKind: ClassifiedErrorKind,
  hints?: ClassifyFailureHints,
): ClassifiedFailure {
  const causeChain = collectCauseChain(error);
  const githubFields = failureDomain === "github" ? githubHttpFields(error) : {};
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
    ...githubFields,
  };
}

const POSTHOG_SAFE_PHASES = new Set([
  "preflight",
  "db-read",
  "investigation",
  "pre_submit",
  "validation_repair",
  "publish_recovery",
  "plaintext_fallback",
  "recon",
  "specialist",
  "judgment",
  "synthesis",
  "publish",
  "ci_summary",
  "ask",
  "description",
  "triage",
  "verification",
]);

export function posthogSafePhase(phase: string | undefined): string | undefined {
  if (phase == null) return undefined;
  return POSTHOG_SAFE_PHASES.has(phase) ? phase : undefined;
}

const CLASSIFIED_FAILURE_LOG_FIELD_REQUIRED = {
  failureDomain: true,
  errorKind: true,
  errorMessage: true,
  errorCode: false,
  phase: false,
  toolName: false,
  provider: false,
  model: false,
  causeChain: false,
  errorCount: false,
  httpStatus: false,
  requestPath: false,
} as const satisfies { readonly [K in keyof ClassifiedFailure]-?: boolean };

export function classifiedFailureLogFields(f: ClassifiedFailure): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = Object.keys(CLASSIFIED_FAILURE_LOG_FIELD_REQUIRED).filter(
    (field): field is keyof typeof CLASSIFIED_FAILURE_LOG_FIELD_REQUIRED =>
      Object.hasOwn(CLASSIFIED_FAILURE_LOG_FIELD_REQUIRED, field),
  );
  for (const field of fields) {
    const value = f[field];
    if (CLASSIFIED_FAILURE_LOG_FIELD_REQUIRED[field] || value != null) {
      out[field] = value;
    }
  }
  return out;
}
