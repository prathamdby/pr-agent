import type { Config } from "../../config.js";
import type { InstallationToken } from "../../github/appAuth.js";
import type { PullRequestForFileList } from "../../github/listPullRequestFiles.js";
import type { PreparePrRepositoryViewParams } from "../../prWorkspace/prRepositoryView.js";

type WorkItemIdentity = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
};

type RepositoryViewEnv = {
  readonly installation: InstallationToken;
  readonly headSha: string;
  readonly pullRequest?: PullRequestForFileList;
};

type RepositoryViewPayload = {
  readonly repositorySizeKb?: number;
};

export function buildRepositoryViewParams(
  cfg: Config,
  item: WorkItemIdentity,
  env: RepositoryViewEnv,
  payload: RepositoryViewPayload,
  extra?: Pick<PreparePrRepositoryViewParams, "prFiles">,
): PreparePrRepositoryViewParams {
  return {
    cfg,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha: env.headSha,
    installationToken: env.installation.token,
    installationExpiresAtTs: env.installation.expiresAtTs,
    pullRequest: env.pullRequest,
    repositorySizeKb: payload.repositorySizeKb,
    ...(extra?.prFiles !== undefined ? { prFiles: extra.prFiles } : {}),
  };
}
