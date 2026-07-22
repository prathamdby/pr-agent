import {
  isMissingChecksPermissionError,
  listCheckRunsForHead,
  listLegacyCommitStatusesForHead,
} from "../../github/ciStatus.js";
import { logDebug, logWarn } from "../../evlog.js";
import {
  REVIEW_CI_SUMMARY_GRANT_ACTIONS,
  REVIEW_CI_SUMMARY_GRANT_CHECKS,
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_UNAVAILABLE,
  REVIEW_CI_SUMMARY_WAIT_POLL_MS,
} from "../../settings/index.js";
import {
  factsOnlyFailingSummary,
  mergeCiSummaryWithFacts,
  type CiAuthorInput,
  type CiSummaryAuthor,
} from "./authorCiSummary.js";
import type {
  CiCheckRunSnapshot,
  CiFailureDetail,
  CiLegacyStatus,
  CiSummary,
} from "./ciSummaryTypes.js";
import { fetchCiLogContext } from "./fetchCiLogContext.js";

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

export type BuildCiSummaryOptions = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly expiresAtTs?: number;
  /** Max failing checks to dig into with logs. */
  readonly maxFailures?: number;
  /** When true, skip log fetch and LLM (progress stub path). */
  readonly lightweight?: boolean;
  readonly waitMs?: number;
  readonly waitPollMs?: number;
  /**
   * Optional LLM author for failing CI (publish / refresh). When omitted on a failing
   * non-lightweight path, returns a facts-only failing row (no static annotation digest).
   */
  readonly author?: CiSummaryAuthor;
};

type ExternalCiLoad =
  | {
      readonly ok: true;
      readonly checks: CiCheckRunSnapshot[];
      readonly statuses: CiLegacyStatus[];
    }
  | { readonly ok: false; readonly reason: "checks_permission" | "fetch_error" };

export function isOwnCiCheckName(name: string): boolean {
  return name.startsWith(OWN_CHECK_NAME_PREFIX);
}

function isCheckFailing(run: CiCheckRunSnapshot): boolean {
  return (
    run.status === "completed" && run.conclusion != null && FAILING_CONCLUSIONS.has(run.conclusion)
  );
}

function isLegacyFailing(status: CiLegacyStatus): boolean {
  return FAILING_LEGACY_STATES.has(status.state);
}

async function loadExternalCi(options: BuildCiSummaryOptions): Promise<ExternalCiLoad> {
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
      ok: true,
      checks: checks.filter((run) => !isOwnCiCheckName(run.name)),
      statuses: statuses.filter((status) => status.context !== OWN_COMMIT_STATUS_CONTEXT),
    };
  } catch (error) {
    if (isMissingChecksPermissionError(error)) {
      logDebug("review_ci_summary_unavailable", {
        owner: options.owner,
        repo: options.repo,
        prHead: options.headSha,
        reason: "checks_permission",
      });
      return { ok: false, reason: "checks_permission" };
    }
    logWarn("review_ci_summary_fetch_failed", {
      owner: options.owner,
      repo: options.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "fetch_error" };
  }
}

function classifySnapshot(
  checks: readonly CiCheckRunSnapshot[],
  statuses: readonly CiLegacyStatus[],
): "none" | "pending" | "failing" | "passing" {
  if (checks.length === 0 && statuses.length === 0) return "none";
  const anyFailing = checks.some(isCheckFailing) || statuses.some(isLegacyFailing);
  if (anyFailing) return "failing";
  const anyPending =
    checks.some(
      (run) =>
        run.status !== "completed" &&
        (PENDING_CHECK_STATUSES.has(run.status) || run.conclusion == null),
    ) || statuses.some((status) => PENDING_LEGACY_STATES.has(status.state));
  if (anyPending) return "pending";
  return "passing";
}

async function waitForTerminalCi(options: BuildCiSummaryOptions): Promise<ExternalCiLoad> {
  const waitMs = options.waitMs ?? 0;
  const pollMs = Math.max(options.waitPollMs ?? REVIEW_CI_SUMMARY_WAIT_POLL_MS, 100);
  const deadline = Date.now() + waitMs;
  let loaded = await loadExternalCi(options);
  if (!loaded.ok || waitMs <= 0) return loaded;

  while (Date.now() < deadline) {
    const state = classifySnapshot(loaded.checks, loaded.statuses);
    if (state !== "pending") return loaded;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    loaded = await loadExternalCi(options);
    if (!loaded.ok) return loaded;
  }
  return loaded;
}

export function summarizeCiSnapshot(params: {
  readonly checks: readonly CiCheckRunSnapshot[];
  readonly statuses: readonly CiLegacyStatus[];
  readonly failures?: readonly CiFailureDetail[];
  readonly permissionNote?: string;
}): CiSummary {
  const state = classifySnapshot(params.checks, params.statuses);
  const permissionNote = params.permissionNote;
  switch (state) {
    case "none":
      return {
        status: "none",
        headline: "No CI checks on this head",
        failures: [],
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    case "pending":
      return {
        status: "pending",
        headline: "⏳ CI still running",
        failures: [],
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    case "passing":
      return {
        status: "passing",
        headline: "✅ All CI is passing",
        failures: [],
        ...(permissionNote != null ? { permissionNote } : {}),
      };
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
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function unavailableSummary(): CiSummary {
  return {
    status: "unavailable",
    headline: REVIEW_CI_SUMMARY_UNAVAILABLE,
    failures: [],
  };
}

function withPermissionNote(summary: CiSummary, note: string | undefined): CiSummary {
  if (note == null) return summary;
  return { ...summary, permissionNote: note };
}

function buildAuthorInput(
  snapshot: { checks: readonly CiCheckRunSnapshot[]; statuses: readonly CiLegacyStatus[] },
  condensedLogs: string,
  checkOutputFallback: string,
): CiAuthorInput {
  const failingChecks = snapshot.checks.filter(isCheckFailing);
  const failingStatuses = snapshot.statuses.filter(isLegacyFailing);
  const failingNames = [
    ...failingChecks.map((run) => run.name),
    ...failingStatuses.map((status) => status.context),
  ];
  const failingUrls = new Map<string, string | undefined>();
  for (const run of failingChecks) {
    failingUrls.set(run.name, run.htmlUrl ?? undefined);
  }
  for (const status of failingStatuses) {
    failingUrls.set(status.context, status.targetUrl ?? undefined);
  }
  return {
    status: "failing",
    checkNames: [
      ...snapshot.checks.map((run) => run.name),
      ...snapshot.statuses.map((status) => status.context),
    ],
    failingNames: [...new Set(failingNames)],
    failingUrls,
    condensedLogs,
    checkOutputFallback,
  };
}

/**
 * Builds a CI summary for the review progress stub or completed review summary.
 * Missing Checks permission yields a visible grant-Checks row. Missing Actions
 * permission on a failing head attaches a grant-Actions note. Other fetch errors
 * soft-fail to a short unavailable headline. The review itself still publishes.
 *
 * Failing non-lightweight paths fetch condensed Actions logs and optionally call
 * `author` for model-authored reason/fixHint fields (ADR 0026).
 */
export async function buildCiSummary(options: BuildCiSummaryOptions): Promise<CiSummary> {
  try {
    const loaded = await waitForTerminalCi(options);
    if (!loaded.ok) {
      return loaded.reason === "checks_permission"
        ? {
            status: "unavailable",
            headline: REVIEW_CI_SUMMARY_GRANT_CHECKS,
            failures: [],
          }
        : unavailableSummary();
    }

    const snapshot = { checks: loaded.checks, statuses: loaded.statuses };
    const state = classifySnapshot(snapshot.checks, snapshot.statuses);
    if (state !== "failing" || options.lightweight) {
      return summarizeCiSnapshot(snapshot);
    }

    const maxFailures = options.maxFailures ?? REVIEW_CI_SUMMARY_MAX_FAILURES;
    const failingChecks = snapshot.checks.filter(isCheckFailing).slice(0, maxFailures);
    const { condensedLogs, checkOutputFallback, actionsPermissionMissing } =
      await fetchCiLogContext({
        token: options.token,
        owner: options.owner,
        repo: options.repo,
        headSha: options.headSha,
        expiresAtTs: options.expiresAtTs,
        failingChecks,
        maxFailures,
      });

    const authorInput = buildAuthorInput(snapshot, condensedLogs, checkOutputFallback);
    const actionsNote = actionsPermissionMissing ? REVIEW_CI_SUMMARY_GRANT_ACTIONS : undefined;

    if (options.author == null) {
      return withPermissionNote(factsOnlyFailingSummary(authorInput), actionsNote);
    }

    const llm = await options.author(authorInput);
    if (llm == null) {
      return withPermissionNote(factsOnlyFailingSummary(authorInput), actionsNote);
    }
    return withPermissionNote(mergeCiSummaryWithFacts(authorInput, llm), actionsNote);
  } catch (error) {
    logWarn("review_ci_summary_build_failed", {
      owner: options.owner,
      repo: options.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    return unavailableSummary();
  }
}
