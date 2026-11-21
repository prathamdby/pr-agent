import { headCiFactsAreComplete, ciSummaryFromFacts, waitingCiSummary } from "../ci/ciFacts.ts";
import { loadGithubCiSourceAvailability } from "../../state/githubCapabilities.ts";
import {
  headCiNeedsSeed,
  loadPrHeadCiState,
  scheduleNextProjection,
} from "../../state/prHeadCiState.ts";
import type { PublishDb } from "../../state/publish.ts";
import type { ReviewHeadCiPort } from "../publish/reviewPublishSession.ts";

export function sqliteReviewHeadCi(params: {
  readonly db: PublishDb;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly now?: () => number;
}) {
  const repoKey = `${params.owner}/${params.repo}`;
  const now = params.now ?? Date.now;
  return ((pinnedReturn: ReviewHeadCiPort) => pinnedReturn)({
    load: async (headSha) => {
      const sourceAvailability = loadGithubCiSourceAvailability(params.db, {
        installationId: params.installationId,
        owner: params.owner,
        repo: params.repo,
        headSha,
      });
      const row = loadPrHeadCiState(params.db, { repoKey, headSha });
      if (row === undefined) return waitingCiSummary(0);
      if (
        headCiNeedsSeed({ seededAt: row.seededAt == null ? null : new Date(row.seededAt) }) &&
        sourceAvailability.checks.access !== "denied" &&
        sourceAvailability.statuses.access !== "denied"
      )
        return waitingCiSummary(row.state.version);
      return ciSummaryFromFacts(row.state.checks, row.state.version, row.state.authored, {
        checkRunsComplete: headCiFactsAreComplete(row.state.rollup),
        sourceAvailability,
      });
    },
    requestProjection: (headSha, renderedVersion) => {
      if (params.installationId <= 0) return;
      const row = loadPrHeadCiState(params.db, { repoKey, headSha });
      const due = row === undefined || row.seededAt == null || row.state.version > renderedVersion;
      if (!due || row === undefined) return;
      scheduleNextProjection(params.db, { repoKey, headSha, at: now() }, now());
    },
  });
}
