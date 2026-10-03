import type { ListPullRequestFilesResult } from "../../github/listPullRequestFiles.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
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
  const files = workspace.reader.changedFiles.map((file) => ({ filename: file.path }));
  return {
    files,
    truncated: workspace.reader.stats.truncated,
    fileCount: workspace.reader.stats.fileCount,
    totalChanges: workspace.reader.stats.totalChanges,
  };
}
