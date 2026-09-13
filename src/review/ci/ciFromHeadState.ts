import { summarizeCiFacts } from "./analyzeCi.js";
import type { CiCheckFact } from "./classifySnapshot.js";
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

export function ciSummaryFromFacts(
  checks: Readonly<Record<string, CiCheckFact>>,
  version: number,
): RenderableHeadCi {
  const facts = summarizeCiFacts(checks);
  if (facts.status === "none") {
    return { summary: WAITING_FOR_CI_SUMMARY, version };
  }
  return { summary: facts, version };
}

export function waitingCiSummary(version = 0): RenderableHeadCi {
  return { summary: WAITING_FOR_CI_SUMMARY, version };
}
