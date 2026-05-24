import { buildReviewPathProfile, formatReviewPathProfileBlock } from "./reviewPathProfile.js";
import type { ReviewPreflightMetadata } from "./reviewPreflightFiles.js";
import { buildReviewSizeBudget, formatReviewSizeBudgetBlock } from "./reviewSizeBudget.js";

export function buildTrustedReviewContextBlock(metadata: ReviewPreflightMetadata): string {
  const filenames = metadata.files.map((file) => file.filename);
  const pathProfile = buildReviewPathProfile(filenames);
  const sizeBudget = buildReviewSizeBudget({
    fileCount: metadata.fileCount,
    totalChanges: metadata.totalChanges,
    truncated: metadata.truncated,
  });

  return [
    formatReviewPathProfileBlock(pathProfile),
    "",
    formatReviewSizeBudgetBlock(sizeBudget),
  ].join("\n");
}
