import type { Config } from "../config.js";
import { REVIEWER_IDS } from "../review/prompts/reviewerPrompt.js";

/** Derived max provider pressure for one worker process (ADR 0022 cost model). */
export function deriveReviewProviderPressure(cfg: Config) {
  const reviewerRosterSize = REVIEWER_IDS.length;
  const maxConcurrentReviewerSessions = cfg.reviewConcurrency * cfg.reviewAgentConcurrency;
  return {
    reviewConcurrency: cfg.reviewConcurrency,
    reviewAgentConcurrency: cfg.reviewAgentConcurrency,
    reviewerRosterSize,
    maxConcurrentReviewerSessions,
    reviewValidationMaxCandidates: cfg.reviewValidationMaxCandidates,
    maxToolRoundsReviewer: cfg.maxToolRoundsReviewer,
    maxToolRoundsValidator: cfg.maxToolRoundsValidator,
    maxToolRoundsOrchestrator: cfg.maxToolRoundsOrchestrator,
    // Per active Review job after fan-out: validators and one orchestrator run sequentially.
    maxValidatorsPerReviewJob: cfg.reviewValidationMaxCandidates,
    maxOrchestratorsPerReviewJob: 1,
  };
}
