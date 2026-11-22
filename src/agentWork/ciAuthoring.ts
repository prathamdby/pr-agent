import type { DatabaseSync } from "node:sqlite";
import type { createFeaturePiSession } from "../agent/runtime/createFeatureSession.ts";
import type { Config } from "../settings/index.ts";
import type { PrSurface } from "../github/prSurface.ts";
import {
  createAgentCiSummaryAuthor,
  factsOnlyFailingSummary,
  mergeCiSummaryWithFacts,
  type CiSummaryAuthor,
  ciAuthorInputFromFacts,
  fetchCiAuthorContext,
} from "../review/ci/ciAuthor.ts";
import { hashCiFacts, parseCiAuthoredCache, type CiAuthoredCache } from "../review/ci/ciFacts.ts";
import { storeHeadCiAuthored, type HeadCiProjectionRow } from "../state/prHeadCiState.ts";

export async function authorHeadCiIfFactsChanged(params: {
  readonly cfg: Config;
  readonly db: DatabaseSync;
  readonly prSurface: PrSurface;
  readonly row: HeadCiProjectionRow;
  readonly author?: CiSummaryAuthor;
  readonly createSession?: typeof createFeaturePiSession;
}) {
  if (params.row.rollup !== "failing")
    return ((pinnedReturn: HeadCiProjectionRow | Promise<HeadCiProjectionRow>) => pinnedReturn)(
      params.row,
    );
  const factsHash = hashCiFacts(params.row.checks);
  const cached = parseCiAuthoredCache(params.row.authored);
  if (cached?.factsHash === factsHash)
    return ((pinnedReturn: HeadCiProjectionRow | Promise<HeadCiProjectionRow>) => pinnedReturn)(
      params.row,
    );

  const context = await fetchCiAuthorContext({
    prSurface: params.prSurface,
    headSha: params.row.headSha,
    checks: params.row.checks,
  });
  const input = ciAuthorInputFromFacts(params.row.checks, context.condensedLogs);
  const author = params.author ?? createAgentCiSummaryAuthor(params.cfg, params.createSession);
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
  storeHeadCiAuthored(params.db, { ...params.row, authored });
  return ((pinnedReturn: HeadCiProjectionRow | Promise<HeadCiProjectionRow>) => pinnedReturn)({
    ...params.row,
    authored,
  });
}
