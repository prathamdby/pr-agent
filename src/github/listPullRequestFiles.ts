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

type PatchBudgetState = {
  patchCapReached: boolean;
  patchBytes: number;
};

function resolvePatchForFile(
  rawPatch: string | undefined,
  state: PatchBudgetState,
  maxPatchBytes: number,
): {
  patch: string | undefined;
  patchOmitted: true | undefined;
  state: PatchBudgetState;
  patchOmittedCountDelta: number;
} {
  if (rawPatch == null) {
    return {
      patch: undefined,
      patchOmitted: undefined,
      state,
      patchOmittedCountDelta: 0,
    };
  }
  if (state.patchCapReached) {
    return {
      patch: undefined,
      patchOmitted: true,
      state,
      patchOmittedCountDelta: 1,
    };
  }
  const patchLen = Buffer.byteLength(rawPatch, "utf8");
  if (state.patchBytes + patchLen <= maxPatchBytes) {
    return {
      patch: rawPatch,
      patchOmitted: undefined,
      state: { patchCapReached: false, patchBytes: state.patchBytes + patchLen },
      patchOmittedCountDelta: 0,
    };
  }
  return {
    patch: undefined,
    patchOmitted: true,
    state: { ...state, patchCapReached: true },
    patchOmittedCountDelta: 1,
  };
}

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

      const resolved = resolvePatchForFile(
        file.patch ?? undefined,
        { patchCapReached, patchBytes },
        limits.maxPrFilesPatchBytes,
      );
      patchCapReached = resolved.state.patchCapReached;
      patchBytes = resolved.state.patchBytes;
      patchOmittedCount += resolved.patchOmittedCountDelta;

      files.push(mapGithubFile(file, resolved.patch, resolved.patchOmitted));
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
