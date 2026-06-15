import type { ListPullRequestFilesResult } from "../github/listPullRequestFiles.js";
import type { LocalPrWorkspace } from "../prWorkspace/index.js";
import type { PreflightFileEntry } from "./reviewChangeGate.js";

export type ReviewPreflightMetadata = {
  readonly files: readonly PreflightFileEntry[];
  readonly truncated: boolean;
  readonly fileCount: number;
  readonly totalChanges: number;
};

export function buildReviewPreflightMetadata(
  source:
    | { kind: "pullRequestFiles"; value: ListPullRequestFilesResult }
    | { kind: "workspace"; value: LocalPrWorkspace },
): ReviewPreflightMetadata {
  if (source.kind === "pullRequestFiles") {
    const files = source.value.files.map((file) => ({ filename: file.filename }));
    return {
      files,
      truncated: source.value.truncated,
      fileCount: files.length,
      totalChanges: source.value.totalChanges,
    };
  }

  const files = source.value.changedFiles.map((file) => ({ filename: file.path }));
  return {
    files,
    truncated: source.value.stats.truncated,
    fileCount: source.value.stats.fileCount,
    totalChanges: source.value.stats.totalChanges,
  };
}
