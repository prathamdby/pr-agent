export type SubmitReviewState = {
  published: boolean;
  inlineReviewIds: number[];
  threadCallCount: number;
  lastValidationError: string | null;
  publishCallCount: number;
  publishCallsExhausted: boolean;
  publishSuperseded: boolean;
};

export function createSubmitReviewState(initial?: {
  readonly published?: boolean;
  readonly inlineReviewIds?: readonly number[];
  readonly threadCallCount?: number;
}): SubmitReviewState {
  return {
    published: initial?.published ?? false,
    inlineReviewIds: [...(initial?.inlineReviewIds ?? [])],
    lastValidationError: null,
    publishCallCount: 0,
    publishCallsExhausted: false,
    publishSuperseded: false,
    threadCallCount: initial?.threadCallCount ?? 0,
  };
}
