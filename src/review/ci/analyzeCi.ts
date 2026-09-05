import { isMissingChecksPermissionError } from "../../github/ciStatus.js";
import { classifyGithubError } from "../../github/githubErrors.js";
import { logDebug, logWarn } from "../../evlog.js";
import {
  REVIEW_CI_SUMMARY_FETCH_CONCURRENCY,
  REVIEW_CI_SUMMARY_GRANT_ACTIONS,
  REVIEW_CI_SUMMARY_GRANT_CHECKS,
  REVIEW_CI_SUMMARY_INCOMPLETE,
  REVIEW_CI_SUMMARY_LOG_MAX_JOBS,
  REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
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
  CiCheckAnnotation,
  CiCheckRunSnapshot,
  CiFailureDetail,
  CiLegacyStatus,
  CiSummary,
} from "./ciSummaryTypes.js";
import type { PrSurface } from "../../github/prSurface.js";
import {
  condenseJobLogText,
  selectEffectiveCiContext,
  type CondensedJobLog,
} from "./condenseCiLogs.js";

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

type BuildCiSummaryOptions = {
  readonly prSurface: PrSurface;
  readonly headSha: string;
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

type FetchCiLogContextResult = {
  readonly condensedLogs: string;
  readonly actionsPermissionMissing: boolean;
};

async function mapBounded<T, R>(
  items: readonly T[],
  bound: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const workerCount = Math.min(Math.max(bound, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) continue;
        results[index] = await mapper(item, index);
      }
    }),
  );
  return results;
}

function checkOutputChunks(run: CiCheckRunSnapshot): string[] {
  return [run.outputTitle, run.outputSummary, run.outputText]
    .filter((part): part is string => part != null && part.trim().length > 0)
    .map((part) => part.trim());
}

function formatFailureAnnotations(annotations: readonly CiCheckAnnotation[]): string[] {
  const failureAnnotations = annotations.filter((a) => a.annotationLevel === "failure");
  const lines: string[] = [];
  for (const annotation of failureAnnotations.slice(0, 5)) {
    const loc =
      annotation.startLine != null ? `${annotation.path}:${annotation.startLine}` : annotation.path;
    lines.push(`${loc} — ${annotation.message}`);
  }
  return lines;
}

async function fetchCiLogContext(options: {
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly failingChecks: readonly CiCheckRunSnapshot[];
  readonly maxFailures?: number;
}): Promise<FetchCiLogContextResult> {
  const maxFailures = options.maxFailures ?? REVIEW_CI_SUMMARY_MAX_FAILURES;
  const failing = options.failingChecks.slice(0, maxFailures);

  const annotationBatches = await mapBounded(
    failing,
    REVIEW_CI_SUMMARY_FETCH_CONCURRENCY,
    async (run) => {
      try {
        return {
          annotations: await options.prSurface.listCheckRunAnnotations(run.id),
          rateLimited: false,
        };
      } catch (error) {
        return {
          annotations: [],
          rateLimited: classifyGithubError(error) === "rate_limit",
        };
      }
    },
  );

  const outputParts: string[] = [];
  for (let i = 0; i < failing.length; i++) {
    const run = failing[i];
    if (run == null) continue;
    const chunks = checkOutputChunks(run);
    if (chunks.length > 0) {
      outputParts.push(`### Check: ${run.name}\n${chunks.join("\n")}`);
    }
    outputParts.push(...formatFailureAnnotations(annotationBatches[i]?.annotations ?? []));
  }
  const checkOutput = outputParts.join("\n\n");

  let jobs: CondensedJobLog[] = [];
  let actionsPermissionMissing = false;
  let logFetchRateLimited = false;
  try {
    const listed = await options.prSurface.listFailingActionsJobs(options.headSha);
    if (!listed.ok) {
      actionsPermissionMissing = true;
      logDebug("review_ci_summary_actions_unavailable", {
        owner: options.prSurface.owner,
        repo: options.prSurface.repo,
        reason: "actions_permission",
      });
    } else {
      const selected = listed.jobs.slice(0, REVIEW_CI_SUMMARY_LOG_MAX_JOBS);
      const downloaded = await mapBounded(
        selected,
        REVIEW_CI_SUMMARY_FETCH_CONCURRENCY,
        async (job) => options.prSurface.downloadActionsJobLogs(job.id),
      );
      for (let i = 0; i < selected.length; i++) {
        const job = selected[i];
        const result = downloaded[i];
        if (job == null || result == null) continue;
        if (!result.ok) {
          if (result.reason === "actions_permission") {
            actionsPermissionMissing = true;
            logDebug("review_ci_summary_actions_unavailable", {
              owner: options.prSurface.owner,
              repo: options.prSurface.repo,
              reason: "actions_permission",
              jobId: job.id,
            });
            break;
          }
          continue;
        }
        jobs.push({
          name: job.name,
          url: job.htmlUrl ?? undefined,
          text: condenseJobLogText(result.text, REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS),
        });
      }
    }
  } catch (error) {
    logFetchRateLimited = classifyGithubError(error) === "rate_limit";
    logDebug("review_ci_summary_actions_logs_failed", {
      owner: options.prSurface.owner,
      repo: options.prSurface.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    jobs = [];
  }

  const rateLimited =
    annotationBatches.filter((batch) => batch.rateLimited).length + (logFetchRateLimited ? 1 : 0);
  if (rateLimited > 0) {
    logDebug("review_ci_summary_github_429", {
      owner: options.prSurface.owner,
      repo: options.prSurface.repo,
      count: rateLimited,
    });
  }

  return {
    condensedLogs: selectEffectiveCiContext({ jobs, checkOutput }),
    actionsPermissionMissing,
  };
}

type ExternalCiLoad =
  | {
      readonly ok: true;
      readonly checks: CiCheckRunSnapshot[];
      readonly statuses: CiLegacyStatus[];
      readonly checkRunsComplete?: boolean;
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
    const { checkRuns, checkRunsComplete, legacyStatuses } = await options.prSurface.getCiStatus(
      options.headSha,
    );
    return {
      ok: true,
      checks: checkRuns.filter((run) => !isOwnCiCheckName(run.name)),
      statuses: legacyStatuses.filter((status) => status.context !== OWN_COMMIT_STATUS_CONTEXT),
      checkRunsComplete,
    };
  } catch (error) {
    if (isMissingChecksPermissionError(error)) {
      logDebug("review_ci_summary_unavailable", {
        owner: options.prSurface.owner,
        repo: options.prSurface.repo,
        prHead: options.headSha,
        reason: "checks_permission",
      });
      return { ok: false, reason: "checks_permission" };
    }
    logWarn("review_ci_summary_fetch_failed", {
      owner: options.prSurface.owner,
      repo: options.prSurface.repo,
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
    if (isTerminalCiLoad(loaded)) return loaded;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    loaded = await loadExternalCi(options);
    if (!loaded.ok) return loaded;
  }
  return loaded;
}

function isTerminalCiLoad(loaded: Extract<ExternalCiLoad, { readonly ok: true }>): boolean {
  const state = classifySnapshot(loaded.checks, loaded.statuses);
  if (state === "pending") return false;
  if (state === "failing") return true;
  return loaded.checkRunsComplete !== false;
}

export function summarizeCiSnapshot(params: {
  readonly checks: readonly CiCheckRunSnapshot[];
  readonly statuses: readonly CiLegacyStatus[];
  readonly failures?: readonly CiFailureDetail[];
  readonly permissionNote?: string;
  readonly checkRunsComplete?: boolean;
}): CiSummary {
  const state = classifySnapshot(params.checks, params.statuses);
  const permissionNote = params.permissionNote;
  const incomplete = params.checkRunsComplete === false;
  if (incomplete && (state === "none" || state === "passing")) {
    return incompleteUnavailableSummary();
  }
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
      const headline = `❌ CI failing — ${nameList}${more}`;
      return {
        status: "failing",
        headline: incomplete ? withPartialCiView(headline) : headline,
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

function incompleteUnavailableSummary(): CiSummary {
  return {
    status: "unavailable",
    headline: REVIEW_CI_SUMMARY_INCOMPLETE,
    failures: [],
  };
}

function withPartialCiView(headline: string): string {
  return headline.includes("(partial CI view)") ? headline : `${headline} (partial CI view)`;
}

function isAllPassingHeadline(headline: string): boolean {
  return /all ci is passing/i.test(headline);
}

function withPermissionNote(summary: CiSummary, note: string | undefined): CiSummary {
  if (note == null) return summary;
  return { ...summary, permissionNote: note };
}

function buildAuthorInput(
  snapshot: { checks: readonly CiCheckRunSnapshot[]; statuses: readonly CiLegacyStatus[] },
  condensedLogs: string,
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
  };
}

export async function buildCiSummaryForSurface(
  prSurface: PrSurface,
  options: Omit<BuildCiSummaryOptions, "prSurface">,
): Promise<CiSummary> {
  return buildCiSummary({ ...options, prSurface });
}

async function buildCiSummary(options: BuildCiSummaryOptions): Promise<CiSummary> {
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

    const snapshot = {
      checks: loaded.checks,
      statuses: loaded.statuses,
      checkRunsComplete: loaded.checkRunsComplete,
    };
    const state = classifySnapshot(snapshot.checks, snapshot.statuses);
    if (state !== "failing" || options.lightweight) {
      return summarizeCiSnapshot(snapshot);
    }

    const maxFailures = options.maxFailures ?? REVIEW_CI_SUMMARY_MAX_FAILURES;
    const failingChecks = snapshot.checks.filter(isCheckFailing).slice(0, maxFailures);
    const { condensedLogs, actionsPermissionMissing } = await fetchCiLogContext({
      prSurface: options.prSurface,
      headSha: options.headSha,
      failingChecks,
      maxFailures,
    });

    const authorInput = buildAuthorInput(snapshot, condensedLogs);
    const actionsNote = actionsPermissionMissing ? REVIEW_CI_SUMMARY_GRANT_ACTIONS : undefined;

    let authored: CiSummary;
    if (options.author == null) {
      authored = withPermissionNote(factsOnlyFailingSummary(authorInput), actionsNote);
    } else {
      const llm = await options.author(authorInput);
      authored =
        llm == null
          ? withPermissionNote(factsOnlyFailingSummary(authorInput), actionsNote)
          : withPermissionNote(mergeCiSummaryWithFacts(authorInput, llm), actionsNote);
    }
    if (snapshot.checkRunsComplete !== false) return authored;
    if (!isAllPassingHeadline(authored.headline)) {
      return { ...authored, headline: withPartialCiView(authored.headline) };
    }
    return summarizeCiSnapshot({
      ...snapshot,
      failures: authored.failures,
      permissionNote: authored.permissionNote,
    });
  } catch (error) {
    logWarn("review_ci_summary_build_failed", {
      owner: options.prSurface.owner,
      repo: options.prSurface.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    return unavailableSummary();
  }
}
