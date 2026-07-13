/** Session role dimension for Reviewer agents, validators, and the Review orchestrator. */
export type ReviewSessionRole = "orchestrator" | "validator" | `reviewer:${string}`;

export type ReviewSessionRoleTotals = {
  readonly modelTurnCount: number;
  readonly toolCallCount: number;
  readonly toolCallErrors: number;
  readonly toolCallDurationMs: number;
  readonly toolResultBytes: number;
  readonly toolResultCharacters: number;
  readonly promptBytes: number;
  readonly promptCharacters: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly providerInputTokens: number;
  readonly providerOutputTokens: number;
};

export type ReviewEnsembleStageMetrics = {
  readonly completedReviewerIds: readonly string[];
  readonly failedReviewerIds: readonly string[];
  readonly selectedReviewerIds: readonly string[];
  readonly omittedReviewerIds: readonly string[];
  readonly candidateFindings: number;
  readonly durationMs: number;
  readonly degraded: boolean;
  readonly validationCandidateCount: number;
  readonly validationTruncatedCandidates: number;
  readonly validationDroppedCount: number;
  readonly validationDurationMs: number;
};

export function emptySessionRoleTotals(): ReviewSessionRoleTotals {
  return {
    modelTurnCount: 0,
    toolCallCount: 0,
    toolCallErrors: 0,
    toolCallDurationMs: 0,
    toolResultBytes: 0,
    toolResultCharacters: 0,
    promptBytes: 0,
    promptCharacters: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
  };
}
