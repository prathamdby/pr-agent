import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { PrSurface } from "../github/prSurface.js";
import {
  createAgentCiSummaryAuthor,
  factsOnlyFailingSummary,
  mergeCiSummaryWithFacts,
  type CiSummaryAuthor,
} from "../review/ci/authorCiSummary.js";
import {
  hashCiFacts,
  parseCiAuthoredCache,
  type CiAuthoredCache,
} from "../review/ci/ciAuthoredCache.js";
import { ciAuthorInputFromFacts, fetchCiAuthorContext } from "../review/ci/fetchCiAuthorContext.js";
import { storePrHeadCiAuthored, type PrHeadCiStateRow } from "./prHeadCiState.js";

export async function authorHeadCiIfFactsChanged(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly row: PrHeadCiStateRow;
  readonly author?: CiSummaryAuthor;
}): Promise<PrHeadCiStateRow> {
  if (params.row.rollup !== "failing") return params.row;
  const factsHash = hashCiFacts(params.row.checks);
  const cached = parseCiAuthoredCache(params.row.authored);
  if (cached?.factsHash === factsHash) return params.row;

  const context = await fetchCiAuthorContext({
    prSurface: params.prSurface,
    headSha: params.row.headSha,
    checks: params.row.checks,
  });
  const input = ciAuthorInputFromFacts(params.row.checks, context.condensedLogs);
  const author = params.author ?? createAgentCiSummaryAuthor(params.cfg);
  const llm = await author(input);
  const summary =
    llm != null ? mergeCiSummaryWithFacts(input, llm) : factsOnlyFailingSummary(input);
  const authored: CiAuthoredCache = {
    factsHash,
    headline: summary.headline,
    failures: summary.failures,
    authoredAt: new Date().toISOString(),
    ...((summary.permissionNote ?? context.permissionNote)
      ? { permissionNote: summary.permissionNote ?? context.permissionNote }
      : {}),
  };
  await storePrHeadCiAuthored(
    params.pool,
    params.row.owner,
    params.row.repo,
    params.row.headSha,
    authored,
  );
  return { ...params.row, authored };
}
