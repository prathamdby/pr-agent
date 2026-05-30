import { installationOctokit } from "../github/appAuth.js";
import type { LocalPrWorkspace } from "../prWorkspace/index.js";
import type { PreflightFileEntry } from "./reviewChangeGate.js";

export type ReviewPreflightMetadata = {
  readonly files: readonly PreflightFileEntry[];
  readonly truncated: boolean;
  readonly fileCount: number;
  readonly totalChanges: number;
};

export async function fetchReviewPreflightMetadata(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  limits: { maxPrFilesListed: number },
): Promise<ReviewPreflightMetadata> {
  const octokit = installationOctokit(token);
  const files: PreflightFileEntry[] = [];
  let truncated = false;
  let totalChanges = 0;

  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;

    for (const file of data) {
      if (files.length >= limits.maxPrFilesListed) {
        truncated = true;
        break;
      }
      files.push({ filename: file.filename });
      totalChanges += file.changes;
    }

    if (truncated || data.length < 100) break;
  }

  return {
    files,
    truncated,
    fileCount: files.length,
    totalChanges,
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
