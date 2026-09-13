import type { PrSurface } from "../../github/prSurface.js";
import {
  REVIEW_CI_SUMMARY_GRANT_ACTIONS,
  REVIEW_CI_SUMMARY_LOG_MAX_JOBS,
} from "../../settings/index.js";
import type { CiAuthorInput } from "./authorCiSummary.js";
import { isCheckFactFailing, type CiCheckFact } from "./classifySnapshot.js";
import {
  condenseJobLogText,
  selectEffectiveCiContext,
  type CondensedJobLog,
} from "./condenseCiLogs.js";

export type CiAuthorContext = {
  readonly condensedLogs: string;
  readonly permissionNote?: string;
};

export function ciAuthorInputFromFacts(
  checks: Readonly<Record<string, CiCheckFact>>,
  condensedLogs: string,
): CiAuthorInput {
  const facts = Object.values(checks);
  const failing = facts.filter(isCheckFactFailing);
  return {
    status: "failing",
    checkNames: facts.map((fact) => fact.name),
    failingNames: failing.map((fact) => fact.name),
    failingUrls: new Map(failing.map((fact) => [fact.name, fact.url ?? undefined])),
    condensedLogs,
  };
}

export async function fetchCiAuthorContext(params: {
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly checks: Readonly<Record<string, CiCheckFact>>;
}): Promise<CiAuthorContext> {
  const failing = Object.values(params.checks).filter(isCheckFactFailing);
  const jobs: CondensedJobLog[] = [];
  let actionsPermissionMissing = false;

  const byCheckRunId = failing.filter((fact) => fact.check_run_id != null);
  for (const fact of byCheckRunId.slice(0, REVIEW_CI_SUMMARY_LOG_MAX_JOBS)) {
    const downloaded = await params.prSurface.downloadActionsJobLogs(fact.check_run_id ?? 0);
    if (!downloaded.ok && downloaded.reason === "actions_permission") {
      actionsPermissionMissing = true;
      break;
    }
    if (!downloaded.ok) continue;
    jobs.push({
      name: fact.name,
      ...(fact.url != null ? { url: fact.url } : {}),
      text: condenseJobLogText(downloaded.text),
    });
  }

  if (jobs.length === 0 && !actionsPermissionMissing) {
    const listed = await params.prSurface.listFailingActionsJobs(params.headSha);
    if (!listed.ok) {
      actionsPermissionMissing = listed.reason === "actions_permission";
    } else {
      for (const job of listed.jobs.slice(0, REVIEW_CI_SUMMARY_LOG_MAX_JOBS)) {
        const downloaded = await params.prSurface.downloadActionsJobLogs(job.id);
        if (!downloaded.ok && downloaded.reason === "actions_permission") {
          actionsPermissionMissing = true;
          break;
        }
        if (!downloaded.ok) continue;
        jobs.push({
          name: job.name,
          ...(job.htmlUrl != null ? { url: job.htmlUrl } : {}),
          text: condenseJobLogText(downloaded.text),
        });
      }
    }
  }

  return {
    condensedLogs: selectEffectiveCiContext({ jobs }),
    ...(actionsPermissionMissing ? { permissionNote: REVIEW_CI_SUMMARY_GRANT_ACTIONS } : {}),
  };
}
