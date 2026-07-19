import {
  isMissingChecksPermissionError,
  listCheckRunAnnotations,
  listCheckRunsForHead,
  listLegacyCommitStatusesForHead,
} from "../../github/ciStatus.js";
import { logDebug, logWarn } from "../../evlog.js";
import {
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_WAIT_POLL_MS,
} from "../../settings/index.js";
import { redactReviewText } from "../findings/reviewPublicOutput.js";
import type {
  CiCheckAnnotation,
  CiCheckRunSnapshot,
  CiFailureDetail,
  CiLegacyStatus,
  CiSummary,
} from "./ciSummaryTypes.js";

const OWN_CHECK_NAME_PREFIX = "PR Agent";
const OWN_COMMIT_STATUS_CONTEXT = "pr-agent/review";

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

const PENDING_CHECK_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);

const FAILING_LEGACY_STATES = new Set(["failure", "error"]);
const PENDING_LEGACY_STATES = new Set(["pending"]);

const ERROR_LINE_RE =
  /\b(error|failed|failure|FAIL|AssertionError|TypeError|ENOENT|ELIFECYCLE|✖|✗|×)\b/i;

export type BuildCiSummaryOptions = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly expiresAtTs?: number;
  /** Max failing checks to dig into with annotations. */
  readonly maxFailures?: number;
  /** When true, skip annotation fetches (progress stub path). */
  readonly lightweight?: boolean;
  readonly waitMs?: number;
  readonly waitPollMs?: number;
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isOwnCiCheckName(name: string): boolean {
  return name.startsWith(OWN_CHECK_NAME_PREFIX);
}

export function isOwnCommitStatusContext(context: string): boolean {
  return context === OWN_COMMIT_STATUS_CONTEXT;
}

function isCheckPending(run: CiCheckRunSnapshot): boolean {
  if (run.status === "completed") return false;
  return PENDING_CHECK_STATUSES.has(run.status) || run.conclusion == null;
}

function isCheckFailing(run: CiCheckRunSnapshot): boolean {
  return (
    run.status === "completed" && run.conclusion != null && FAILING_CONCLUSIONS.has(run.conclusion)
  );
}

function isLegacyPending(status: CiLegacyStatus): boolean {
  return PENDING_LEGACY_STATES.has(status.state);
}

function isLegacyFailing(status: CiLegacyStatus): boolean {
  return FAILING_LEGACY_STATES.has(status.state);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstUsefulLine(text: string | null | undefined): string | null {
  if (text == null) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => collapseWhitespace(line))
    .filter((line) => line.length > 0);
  const errorLine = lines.find((line) => ERROR_LINE_RE.test(line));
  return errorLine ?? lines[0] ?? null;
}

function annotationReason(annotation: CiCheckAnnotation): string {
  const location =
    annotation.path.length > 0
      ? annotation.startLine != null
        ? `${annotation.path}:${annotation.startLine}`
        : annotation.path
      : null;
  const message = collapseWhitespace(annotation.message);
  const title = annotation.title != null ? collapseWhitespace(annotation.title) : null;
  const body =
    title != null && title.length > 0 && !message.includes(title)
      ? `${title}: ${message}`
      : message;
  if (location != null) return `${location} — ${body}`;
  return body;
}

function fixHintFromReason(name: string, reason: string): string {
  const lower = `${name} ${reason}`.toLowerCase();
  if (/\b(lint|eslint|oxlint|prettier|fmt|format)\b/.test(lower)) {
    return "Fix the reported lint/format findings locally, then re-push.";
  }
  if (/\b(typecheck|tsc|typescript|type error)\b/.test(lower)) {
    return "Resolve the TypeScript errors and re-run the typecheck job.";
  }
  if (/\b(test|spec|vitest|jest|pytest|assertion)\b/.test(lower)) {
    return "Reproduce the failing test locally, fix the regression, and re-push.";
  }
  if (/\b(build|compile|bundle)\b/.test(lower)) {
    return "Reproduce the build failure locally, fix the compile/bundle error, and re-push.";
  }
  return `Inspect the failing “${name}” check, fix the reported error, and re-push.`;
}

function digestCheckFailure(
  run: CiCheckRunSnapshot,
  annotations: readonly CiCheckAnnotation[],
): CiFailureDetail {
  const failureAnnotations = annotations.filter(
    (annotation) =>
      annotation.annotationLevel === "failure" || annotation.annotationLevel === "warning",
  );
  const primary = failureAnnotations[0] ?? annotations[0];
  const fromAnnotation = primary != null ? annotationReason(primary) : null;
  const fromOutput =
    firstUsefulLine(run.outputText) ??
    firstUsefulLine(run.outputSummary) ??
    firstUsefulLine(run.outputTitle);
  const reason =
    fromAnnotation ??
    fromOutput ??
    (run.conclusion != null
      ? `Check concluded ${run.conclusion.replace(/_/g, " ")}.`
      : "Check failed without a published summary.");
  return {
    name: run.name,
    reason: redactReviewText(reason),
    fixHint: redactReviewText(fixHintFromReason(run.name, reason)),
    url: run.htmlUrl ?? undefined,
  };
}

function digestLegacyFailure(status: CiLegacyStatus): CiFailureDetail {
  const reason =
    status.description != null && status.description.trim().length > 0
      ? collapseWhitespace(status.description)
      : `Commit status “${status.context}” is ${status.state}.`;
  return {
    name: status.context,
    reason: redactReviewText(reason),
    fixHint: redactReviewText(fixHintFromReason(status.context, reason)),
    url: status.targetUrl ?? undefined,
  };
}

async function loadExternalCi(
  options: BuildCiSummaryOptions,
): Promise<{ checks: CiCheckRunSnapshot[]; statuses: CiLegacyStatus[] } | null> {
  try {
    const [checks, statuses] = await Promise.all([
      listCheckRunsForHead(
        options.token,
        options.owner,
        options.repo,
        options.headSha,
        options.expiresAtTs,
      ),
      listLegacyCommitStatusesForHead(
        options.token,
        options.owner,
        options.repo,
        options.headSha,
        options.expiresAtTs,
      ),
    ]);
    return {
      checks: checks.filter((run) => !isOwnCiCheckName(run.name)),
      statuses: statuses.filter((status) => !isOwnCommitStatusContext(status.context)),
    };
  } catch (error) {
    if (isMissingChecksPermissionError(error)) {
      logDebug("review_ci_summary_unavailable", {
        owner: options.owner,
        repo: options.repo,
        prHead: options.headSha,
        reason: "checks_permission",
      });
      return null;
    }
    logWarn("review_ci_summary_fetch_failed", {
      owner: options.owner,
      repo: options.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function classifySnapshot(
  checks: readonly CiCheckRunSnapshot[],
  statuses: readonly CiLegacyStatus[],
): "none" | "pending" | "failing" | "passing" {
  if (checks.length === 0 && statuses.length === 0) return "none";
  const anyFailing = checks.some(isCheckFailing) || statuses.some(isLegacyFailing);
  if (anyFailing) return "failing";
  const anyPending = checks.some(isCheckPending) || statuses.some(isLegacyPending);
  if (anyPending) return "pending";
  return "passing";
}

async function waitForTerminalCi(
  options: BuildCiSummaryOptions,
): Promise<{ checks: CiCheckRunSnapshot[]; statuses: CiLegacyStatus[] } | null> {
  const waitMs = options.waitMs ?? 0;
  const pollMs = Math.max(options.waitPollMs ?? REVIEW_CI_SUMMARY_WAIT_POLL_MS, 100);
  const deadline = Date.now() + waitMs;
  let snapshot = await loadExternalCi(options);
  if (snapshot == null || waitMs <= 0) return snapshot;

  while (Date.now() < deadline) {
    const state = classifySnapshot(snapshot.checks, snapshot.statuses);
    if (state !== "pending") return snapshot;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleepMs(Math.min(pollMs, remaining));
    snapshot = await loadExternalCi(options);
    if (snapshot == null) return null;
  }
  return snapshot;
}

export function summarizeCiSnapshot(params: {
  readonly checks: readonly CiCheckRunSnapshot[];
  readonly statuses: readonly CiLegacyStatus[];
  readonly failures?: readonly CiFailureDetail[];
}): CiSummary {
  const state = classifySnapshot(params.checks, params.statuses);
  switch (state) {
    case "none":
      return { status: "none", headline: "No CI checks on this head", failures: [] };
    case "pending":
      return { status: "pending", headline: "⏳ CI still running", failures: [] };
    case "passing":
      return { status: "passing", headline: "✅ All CI is passing", failures: [] };
    case "failing": {
      const failures = params.failures ?? [];
      const failingNames = [
        ...params.checks.filter(isCheckFailing).map((run) => run.name),
        ...params.statuses.filter(isLegacyFailing).map((status) => status.context),
      ];
      const uniqueNames = [...new Set(failingNames)];
      const nameList = uniqueNames.slice(0, 3).join(", ");
      const more = uniqueNames.length > 3 ? ` (+${uniqueNames.length - 3} more)` : "";
      return {
        status: "failing",
        headline: `❌ CI failing — ${nameList}${more}`,
        failures,
      };
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

const UNAVAILABLE_CI_SUMMARY: CiSummary = {
  status: "unavailable",
  headline: "CI status unavailable",
  failures: [],
};

/**
 * Builds a CI summary for the review progress stub or completed review summary.
 * Soft-fails to `unavailable` when Checks permission is missing, the fetch errors,
 * or any unexpected exception escapes the helpers below.
 */
export async function buildCiSummary(options: BuildCiSummaryOptions): Promise<CiSummary> {
  try {
    const snapshot = await waitForTerminalCi(options);
    if (snapshot == null) {
      return UNAVAILABLE_CI_SUMMARY;
    }

    const state = classifySnapshot(snapshot.checks, snapshot.statuses);
    if (state !== "failing" || options.lightweight) {
      return summarizeCiSnapshot(snapshot);
    }

    const maxFailures = options.maxFailures ?? REVIEW_CI_SUMMARY_MAX_FAILURES;
    const failingChecks = snapshot.checks.filter(isCheckFailing).slice(0, maxFailures);
    const failures = await Promise.all(
      failingChecks.map(async (run) => {
        let annotations: CiCheckAnnotation[] = [];
        try {
          annotations = await listCheckRunAnnotations(
            options.token,
            options.owner,
            options.repo,
            run.id,
            options.expiresAtTs,
          );
        } catch (error) {
          if (!isMissingChecksPermissionError(error)) {
            logDebug("review_ci_annotations_failed", {
              owner: options.owner,
              repo: options.repo,
              checkRunId: run.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return digestCheckFailure(run, annotations);
      }),
    );

    const remainingSlots = Math.max(0, maxFailures - failures.length);
    for (const status of snapshot.statuses.filter(isLegacyFailing).slice(0, remainingSlots)) {
      failures.push(digestLegacyFailure(status));
    }

    return summarizeCiSnapshot({ ...snapshot, failures });
  } catch (error) {
    logWarn("review_ci_summary_build_failed", {
      owner: options.owner,
      repo: options.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    return UNAVAILABLE_CI_SUMMARY;
  }
}
