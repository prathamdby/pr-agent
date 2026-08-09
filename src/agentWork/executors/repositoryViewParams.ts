import type { InstallationToken } from "../../github/appAuth.js";
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
  readonly installation?: InstallationToken;
  readonly installationToken?: string;
  readonly installationExpiresAtTs?: number;
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
  const installationToken = env.installationToken ?? env.installation?.token;
  if (installationToken == null) {
    throw new Error("buildRepositoryViewParams requires installation or installationToken");
  }
  return {
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha: env.headSha,
    installationToken,
    installationExpiresAtTs: env.installationExpiresAtTs ?? env.installation?.expiresAtTs,
    pullRequest: env.pullRequest,
    repositorySizeKb: payload.repositorySizeKb,
    ...(extra?.prFiles !== undefined ? { prFiles: extra.prFiles } : {}),
  };
}
