import { downloadActionsJobLogs, listFailingActionsJobsForHead } from "../../github/actionsLogs.js";
import { listCheckRunAnnotations } from "../../github/ciStatus.js";
import { logDebug } from "../../evlog.js";
import {
  REVIEW_CI_SUMMARY_LOG_MAX_JOBS,
  REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
  REVIEW_CI_SUMMARY_MAX_FAILURES,
} from "../../settings/index.js";
import { redactReviewText } from "../findings/reviewPublicOutput.js";
import {
  condenseJobLogText,
  mergeCondensedJobLogs,
  type CondensedJobLog,
} from "./condenseCiLogs.js";
import type { CiCheckRunSnapshot } from "./ciSummaryTypes.js";

export type FetchCiLogContextOptions = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly expiresAtTs?: number;
  readonly failingChecks: readonly CiCheckRunSnapshot[];
  readonly maxFailures?: number;
};

export type FetchCiLogContextResult = {
  readonly condensedLogs: string;
  readonly checkOutputFallback: string;
  /** True when the installation cannot read Actions (job logs). */
  readonly actionsPermissionMissing: boolean;
};

/**
 * Downloads Actions job logs for failing checks and returns condensed text plus a
 * check-output fallback when Actions permission is missing.
 */
export async function fetchCiLogContext(
  options: FetchCiLogContextOptions,
): Promise<FetchCiLogContextResult> {
  const maxFailures = options.maxFailures ?? REVIEW_CI_SUMMARY_MAX_FAILURES;
  const failing = options.failingChecks.slice(0, maxFailures);

  const outputParts: string[] = [];
  for (const run of failing) {
    const chunks = [run.outputTitle, run.outputSummary, run.outputText]
      .filter((part): part is string => part != null && part.trim().length > 0)
      .map((part) => part.trim());
    if (chunks.length > 0) {
      outputParts.push(`### Check: ${run.name}\n${chunks.join("\n")}`);
    }
    try {
      const annotations = await listCheckRunAnnotations(
        options.token,
        options.owner,
        options.repo,
        run.id,
        options.expiresAtTs,
      );
      const failureAnnotations = annotations.filter((a) => a.annotationLevel === "failure");
      for (const annotation of failureAnnotations.slice(0, 5)) {
        const loc =
          annotation.startLine != null
            ? `${annotation.path}:${annotation.startLine}`
            : annotation.path;
        outputParts.push(`${loc} — ${annotation.message}`);
      }
    } catch {
      // annotations are best-effort fallback
    }
  }
  const checkOutputFallback = redactReviewText(outputParts.join("\n\n"));

  let jobs: CondensedJobLog[] = [];
  let actionsPermissionMissing = false;
  try {
    const listed = await listFailingActionsJobsForHead(
      options.token,
      options.owner,
      options.repo,
      options.headSha,
      options.expiresAtTs,
    );
    if (!listed.ok) {
      actionsPermissionMissing = true;
      logDebug("review_ci_summary_actions_unavailable", {
        owner: options.owner,
        repo: options.repo,
        reason: "actions_permission",
      });
    } else {
      const selected = listed.jobs.slice(0, REVIEW_CI_SUMMARY_LOG_MAX_JOBS);
      for (const job of selected) {
        const downloaded = await downloadActionsJobLogs(
          options.token,
          options.owner,
          options.repo,
          job.id,
          options.expiresAtTs,
        );
        if (!downloaded.ok) {
          if (downloaded.reason === "actions_permission") {
            actionsPermissionMissing = true;
            logDebug("review_ci_summary_actions_unavailable", {
              owner: options.owner,
              repo: options.repo,
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
          text: condenseJobLogText(downloaded.text, REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS),
        });
      }
    }
  } catch (error) {
    logDebug("review_ci_summary_actions_logs_failed", {
      owner: options.owner,
      repo: options.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    jobs = [];
  }

  const condensedLogs =
    jobs.length > 0 ? mergeCondensedJobLogs(jobs) : condenseJobLogText(checkOutputFallback);

  return { condensedLogs, checkOutputFallback, actionsPermissionMissing };
}
