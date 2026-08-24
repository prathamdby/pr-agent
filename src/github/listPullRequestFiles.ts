import type { RestEndpointMethodTypes } from "@octokit/rest";
import { AppError } from "../errors/appError.js";
import { GITHUB_PULL_REQUEST_FILES_API_MAX_FILES } from "../settings/index.js";
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
  /** Omitted file count after the list-files cap is applied. */
  readonly omittedCountLowerBound: number;
  readonly totalChanges: number;
  readonly headSha?: string;
  readonly warning?: string;
};

export type ListPullRequestFilesLimits = {
  readonly maxPrFilesListed: number;
  readonly maxPrFilesPatchBytes: number;
};

type Octokit = ReturnType<typeof installationOctokit>;
type GithubFile = RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];
export type PullRequestForFileList = {
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly head?: {
    readonly sha?: string | null;
    readonly repo?: { readonly full_name?: string | null } | null;
  } | null;
  readonly base?: {
    readonly repo?: { readonly full_name?: string | null } | null;
  } | null;
};

type PatchBudgetState = {
  patchCapReached: boolean;
  patchBytes: number;
};

export function assertPullRequestFilesHeadSha(
  prFiles: ListPullRequestFilesResult,
  expectedHeadSha: string,
): void {
  if (prFiles.headSha?.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new AppError({
      code: "github.head_sha_mismatch",
      message: `Pull request head SHA ${prFiles.headSha ?? "unknown"} does not match work item headSha ${expectedHeadSha}`,
    });
  }
}

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
      state: {
        patchCapReached: false,
        patchBytes: state.patchBytes + patchLen,
      },
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
  pullRequest?: PullRequestForFileList,
): Promise<ListPullRequestFilesResult> {
  const pull =
    pullRequest ??
    (
      await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      })
    ).data;
  const totalChanges = pull.additions + pull.deletions;
  const headSha = pull.head?.sha ?? undefined;

  const files: PullRequestFileEntry[] = [];
  let patchBytes = 0;
  let patchOmittedCount = 0;
  let patchCapReached = false;

  function consumeFilePage(data: readonly GithubFile[]): void {
    for (const file of data) {
      if (files.length >= limits.maxPrFilesListed) {
        return;
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
    }
  }

  const fetchFilePage = async (page: number) =>
    octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });

  const filesPerPage = 100;
  const maxFilesToList = Math.min(limits.maxPrFilesListed, GITHUB_PULL_REQUEST_FILES_API_MAX_FILES);
  let page = 1;
  let lastPageSize = 0;
  while (files.length < maxFilesToList) {
    const { data } = await fetchFilePage(page);
    lastPageSize = data.length;
    if (data.length === 0) break;
    consumeFilePage(data);
    page++;
    if (data.length < filesPerPage) break;
    if (files.length >= maxFilesToList) break;
  }

  let omittedCountLowerBound = Math.max(0, pull.changed_files - files.length);
  if (files.length >= maxFilesToList && lastPageSize === filesPerPage) {
    const overflowResult = await fetchFilePage(page);
    const overflowPage = overflowResult?.data;
    if (overflowPage && overflowPage.length > 0) {
      omittedCountLowerBound = Math.max(omittedCountLowerBound, overflowPage.length);
    }
  }
  const truncated = omittedCountLowerBound > 0;

  const warnings: string[] = [];
  if (truncated) {
    warnings.push(
      `Change set truncated to ${files.length} files (${omittedCountLowerBound} omitted).`,
    );
  }
  if (patchOmittedCount > 0) {
    warnings.push(
      `Unified diff patches omitted for ${patchOmittedCount} file(s) after ${limits.maxPrFilesPatchBytes} byte cap.`,
    );
  }
  const warning = warnings.length > 0 ? warnings.join(" ") : undefined;

  return {
    files,
    truncated,
    omittedCountLowerBound,
    totalChanges,
    headSha,
    warning,
  };
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
  pullRequest?: PullRequestForFileList,
  expiresAtTs?: number,
): Promise<ListPullRequestFilesResult> {
  const octokit = installationOctokit(token, expiresAtTs);
  return listPullRequestFilesPaginated(octokit, owner, repo, pullNumber, limits, pullRequest);
}
