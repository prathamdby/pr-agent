import { summarizeCiFacts } from "./analyzeCi.js";
import { hashCiFacts, parseCiAuthoredCache } from "./ciAuthoredCache.js";
import type { CiCheckFact, CiRollup } from "./classifySnapshot.js";
import type { CiSummary } from "./ciSummaryTypes.js";

export const WAITING_FOR_CI_SUMMARY: CiSummary = {
  status: "pending",
  headline: "⏳ Waiting for CI",
  failures: [],
};

export type RenderableHeadCi = {
  readonly summary: CiSummary;
  readonly version: number;
};

export function headCiFactsAreComplete(rollup: CiRollup): boolean {
  return rollup !== "unknown";
}

export function ciSummaryFromFacts(
  checks: Readonly<Record<string, CiCheckFact>>,
  version: number,
  authored?: unknown,
  options?: { readonly checkRunsComplete?: boolean },
): RenderableHeadCi {
  const facts = summarizeCiFacts(checks, options);
  const cache = parseCiAuthoredCache(authored);
  if (facts.status === "failing" && cache != null && cache.factsHash === hashCiFacts(checks)) {
    return {
      summary: {
        status: "failing",
        headline: cache.headline,
        failures: cache.failures,
        ...(cache.permissionNote != null ? { permissionNote: cache.permissionNote } : {}),
      },
      version,
    };
  }
  return { summary: facts, version };
}

export function waitingCiSummary(version = 0): RenderableHeadCi {
  return { summary: WAITING_FOR_CI_SUMMARY, version };
}
