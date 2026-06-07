import type { ReviewFinding, ReviewMode } from "../review/reviewSchema.js";

export type AutoFixPlacementKind = "inline" | "summary";

export type AutoFixTarget = {
  readonly id: string;
  readonly bundleId: string;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly reviewLens: ReviewMode;
  readonly headSha: string;
  readonly fingerprint: string;
  readonly severity: "P0" | "P1" | "P2";
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly detail: string;
  readonly fixPrompt: string;
  readonly placementKind: AutoFixPlacementKind;
  readonly inlineReviewCommentId: number | null;
};

export type PersistAutoFixTargetInput = {
  readonly finding: ReviewFinding & { readonly severity: "P0" | "P1" | "P2" };
  readonly fingerprint: string;
  readonly placementKind: AutoFixPlacementKind;
  readonly inlineReviewCommentId?: number;
};

export type AutoFixTargetGroup = {
  readonly targets: readonly AutoFixTarget[];
};
