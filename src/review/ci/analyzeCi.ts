import {
  OWN_COMMIT_STATUS_CONTEXT,
  REVIEW_CI_SUMMARY_INCOMPLETE,
  REVIEW_CI_SUMMARY_UNAVAILABLE,
} from "../../settings/index.js";
import {
  checkRunSnapshotToFact,
  classifyGithubSnapshot,
  isCheckFactFailing,
  legacyStatusToFact,
  type CiCheckFact,
} from "./classifySnapshot.js";
import type { CiCheckRunSnapshot, CiLegacyStatus, CiSummary } from "./ciSummaryTypes.js";

const OWN_CHECK_NAME_PREFIX = "PR Agent";

export function isOwnCiCheckName(name: string): boolean {
  return name.startsWith(OWN_CHECK_NAME_PREFIX);
}

function isCheckFailing(run: CiCheckRunSnapshot): boolean {
  return isCheckFactFailing(checkRunSnapshotToFact(run));
}

function isLegacyFailing(status: CiLegacyStatus): boolean {
  return isCheckFactFailing(legacyStatusToFact(status));
}

function unavailableSummary(headline: string): CiSummary {
  return {
    status: "unavailable",
    headline,
    failures: [],
  };
}

function withPartialCiView(headline: string): string {
  return headline.includes("(partial CI view)") ? headline : `${headline} (partial CI view)`;
}

export function summarizeCiSnapshot(params: {
  readonly checks: readonly CiCheckRunSnapshot[];
  readonly statuses: readonly CiLegacyStatus[];
  readonly failures?: CiSummary["failures"];
  readonly permissionNote?: string;
  readonly checkRunsComplete?: boolean;
}): CiSummary {
  const state = classifyGithubSnapshot(params.checks, params.statuses);
  const permissionNote = params.permissionNote;
  const incomplete = params.checkRunsComplete === false;
  if (incomplete && (state === "none" || state === "passing")) {
    return unavailableSummary(REVIEW_CI_SUMMARY_INCOMPLETE);
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
    case "unknown":
      return {
        status: "unavailable",
        headline: REVIEW_CI_SUMMARY_UNAVAILABLE,
        failures: [],
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function summarizeCiFacts(checks: Readonly<Record<string, CiCheckFact>>): CiSummary {
  const checkRuns: CiCheckRunSnapshot[] = [];
  const statuses: CiLegacyStatus[] = [];
  for (const fact of Object.values(checks)) {
    if (fact.source === "status") {
      statuses.push({
        context: fact.name,
        state: fact.status,
        description: null,
        targetUrl: fact.url,
      });
    } else {
      checkRuns.push({
        id: fact.check_run_id ?? 0,
        name: fact.name,
        externalId: fact.external_id,
        status: fact.status,
        conclusion: fact.conclusion,
        htmlUrl: fact.url,
        outputTitle: null,
        outputSummary: null,
        outputText: null,
      });
    }
  }
  return summarizeCiSnapshot({ checks: checkRuns, statuses });
}

export function isOwnCommitStatusContext(context: string): boolean {
  return context === OWN_COMMIT_STATUS_CONTEXT;
}
