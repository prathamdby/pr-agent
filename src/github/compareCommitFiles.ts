import { installationOctokit } from "./appAuth.js";

/** GitHub compare returns at most 300 files on the first response page. */
const GITHUB_COMPARE_FILES_PAGE_CAP = 300;

export type ListCommitCompareFilesResult = {
  readonly files: string[];
  readonly truncated: boolean;
};

export async function listCommitCompareFiles(params: {
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly base: string;
  readonly head: string;
}): Promise<ListCommitCompareFilesResult> {
  const octokit = installationOctokit(params.token, params.tokenExpiresAtTs);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: params.owner,
    repo: params.repo,
    basehead: `${params.base}...${params.head}`,
  });
  const files = (data.files ?? [])
    .map((file) => file.filename)
    .filter((filename): filename is string => typeof filename === "string" && filename.length > 0);
  return {
    files,
    truncated: files.length >= GITHUB_COMPARE_FILES_PAGE_CAP,
  };
}
