import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.ts";
import type { PreflightFileEntry } from "../run/reviewChangeGate.ts";

export type ReviewPreflightMetadata = {
  readonly files: readonly PreflightFileEntry[];
  readonly truncated: boolean;
  readonly fileCount: number;
  readonly totalChanges: number;
};

export function buildReviewPreflightMetadataFromWorkspace(workspace: LocalPrWorkspace) {
  const files = workspace.reader.changedFiles.map((file) => ({ filename: file.path }));
  return ((pinnedReturn: ReviewPreflightMetadata) => pinnedReturn)({
    files,
    truncated: workspace.reader.stats.truncated,
    fileCount: workspace.reader.stats.fileCount,
    totalChanges: workspace.reader.stats.totalChanges,
  });
}
