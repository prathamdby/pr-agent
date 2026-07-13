import type { Config } from "../config.js";
import { REVIEW_CORE_REVIEWER_IDS } from "../settings/index.js";
import { REVIEWER_IDS } from "../review/prompts/reviewerPrompt.js";

/** Derived max provider pressure for one worker process (ADR 0022/0023 cost model). */
export function deriveReviewProviderPressure(cfg: Config) {
  const reviewerRosterSize = REVIEWER_IDS.length;
  const coreReviewerRosterSize = REVIEW_CORE_REVIEWER_IDS.length;
  const maxConcurrentReviewerSessions = cfg.reviewConcurrency * cfg.reviewAgentConcurrency;
  return {
    reviewConcurrency: cfg.reviewConcurrency,
    reviewAgentConcurrency: cfg.reviewAgentConcurrency,
    reviewerRosterSize,
    // Worst-case roster length remains eight (small tier); medium/large use the core roster.
    coreReviewerRosterSize,
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
