import type { PullRequestForFileList } from "../../github/listPullRequestFiles.js";
import type { PreparePrRepositoryViewParams } from "../../prWorkspace/prRepositoryView.js";

type WorkItemIdentity = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
};

type RepositoryViewEnv = {
  readonly headSha: string;
  readonly pullRequest?: PullRequestForFileList;
  readonly gitCredentialAuth: () => Promise<{
    readonly token: string;
    readonly expiresAtTs: number;
  }>;
};

type RepositoryViewPayload = {
  readonly repositorySizeKb?: number;
};

export function buildRepositoryViewParams(
  item: WorkItemIdentity,
  env: RepositoryViewEnv,
  payload: RepositoryViewPayload,
  extra?: Pick<PreparePrRepositoryViewParams, "prFiles">,
): PreparePrRepositoryViewParams {
  const params: MutablePreparePrRepositoryViewParams = {
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha: env.headSha,
    gitCredentialAuth: env.gitCredentialAuth,
    pullRequest: env.pullRequest,
    repositorySizeKb: payload.repositorySizeKb,
  };
  if (extra?.prFiles !== undefined) params.prFiles = extra.prFiles;
  return params;
}

type MutablePreparePrRepositoryViewParams = {
  -readonly [K in keyof PreparePrRepositoryViewParams]: PreparePrRepositoryViewParams[K];
};
