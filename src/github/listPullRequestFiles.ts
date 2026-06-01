import type { RestEndpointMethodTypes } from "@octokit/rest";
import { installationOctokit } from "./appAuth.js";

export type PullRequestFileEntry = {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly previousFilename?: string;
  readonly patch?: string;
  readonly patchOmitted?: boolean;
};

export type ListPullRequestFilesResult = {
  readonly files: readonly PullRequestFileEntry[];
  readonly truncated: boolean;
  /** Omitted file count; lower bound when more list-files pages may remain. */
  readonly omittedCountLowerBound: number;
  readonly totalChanges: number;
  readonly warning?: string;
};

export type ListPullRequestFilesLimits = {
  readonly maxPrFilesListed: number;
  readonly maxPrFilesPatchBytes: number;
};

type Octokit = ReturnType<typeof installationOctokit>;
type GithubFile = RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];

export async function listPullRequestFilesPaginated(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  limits: ListPullRequestFilesLimits,
): Promise<ListPullRequestFilesResult> {
  const { data: pull } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  const totalChanges = pull.additions + pull.deletions;

  const files: PullRequestFileEntry[] = [];

  let truncated = false;
  let omittedCountLowerBound = 0;
  let omittedCountIsLowerBound = false;
  let patchBytes = 0;
  let patchOmittedCount = 0;
  let patchCapReached = false;

  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    let consumed = 0;
    for (const file of data) {
      if (files.length >= limits.maxPrFilesListed) {
        truncated = true;
        omittedCountLowerBound += data.length - consumed;
        if (data.length === 100) omittedCountIsLowerBound = true;
        break;
      }

      const rawPatch = file.patch ?? undefined;
      let patch: string | undefined = rawPatch;
      let patchOmitted: true | undefined;

      if (rawPatch != null && !patchCapReached) {
        const patchLen = Buffer.byteLength(rawPatch, "utf8");
        if (patchBytes + patchLen <= limits.maxPrFilesPatchBytes) {
          patchBytes += patchLen;
          patchOmitted = undefined;
        } else {
          patchCapReached = true;
          patchOmittedCount++;
          patch = undefined;
          patchOmitted = true;
        }
      } else if (rawPatch != null && patchCapReached) {
        patch = undefined;
        patchOmitted = true;
        patchOmittedCount++;
      } else {
        patch = undefined;
        patchOmitted = undefined;
      }

      files.push(mapGithubFile(file, patch, patchOmitted));
      consumed++;
    }
    if (truncated) break;
    if (data.length < 100) break;
  }

  const warnings: string[] = [];
  if (truncated) {
    const omittedLabel = omittedCountIsLowerBound
      ? `at least ${omittedCountLowerBound}`
      : String(omittedCountLowerBound);
    warnings.push(
      `Change set truncated to ${limits.maxPrFilesListed} files (${omittedLabel} omitted).`,
    );
  }
  if (patchOmittedCount > 0) {
    warnings.push(
      `Unified diff patches omitted for ${patchOmittedCount} file(s) after ${limits.maxPrFilesPatchBytes} byte cap.`,
    );
  }
  const warning = warnings.length > 0 ? warnings.join(" ") : undefined;

  return { files, truncated, omittedCountLowerBound, totalChanges, warning };
}

function mapGithubFile(
  file: GithubFile,
  patch: string | undefined,
  patchOmitted: true | undefined,
): PullRequestFileEntry {
  return {
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    ...(file.previous_filename ? { previousFilename: file.previous_filename } : {}),
    patch,
    ...(patchOmitted ? { patchOmitted } : {}),
  };
}

export async function fetchPullRequestFiles(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  limits: ListPullRequestFilesLimits,
): Promise<ListPullRequestFilesResult> {
  const octokit = installationOctokit(token);
  return listPullRequestFilesPaginated(octokit, owner, repo, pullNumber, limits);
}
