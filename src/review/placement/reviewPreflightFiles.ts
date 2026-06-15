import type { ListPullRequestFilesResult } from "../../github/listPullRequestFiles.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import type { PreflightFileEntry } from "../run/reviewChangeGate.js";

export type ReviewPreflightMetadata = {
  readonly files: readonly PreflightFileEntry[];
  readonly truncated: boolean;
  readonly fileCount: number;
  readonly totalChanges: number;
};

export function buildReviewPreflightMetadataFromPullRequestFiles(
  prFiles: ListPullRequestFilesResult,
): ReviewPreflightMetadata {
  const files = prFiles.files.map((file) => ({ filename: file.filename }));
  return {
    files,
    truncated: prFiles.truncated,
    fileCount: files.length,
    totalChanges: prFiles.totalChanges,
  };
}

export function buildReviewPreflightMetadataFromWorkspace(
  workspace: LocalPrWorkspace,
): ReviewPreflightMetadata {
  const files = workspace.changedFiles.map((file) => ({ filename: file.path }));
  return {
    files,
    truncated: workspace.stats.truncated,
    fileCount: workspace.stats.fileCount,
    totalChanges: workspace.stats.totalChanges,
  };
}
