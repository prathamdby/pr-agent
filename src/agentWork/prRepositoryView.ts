import type { Config } from "../config.js";
import {
  buildReviewPreflightMetadataFromWorkspace,
  type ReviewPreflightMetadata,
} from "../agent/reviewPreflightFiles.js";
import { installationOctokit } from "../github/appAuth.js";
import { prepareLocalPrWorkspace, type LocalPrWorkspace } from "./localPrWorkspace.js";

export type PrRepositoryView = {
  readonly workspace: LocalPrWorkspace;
  readonly preflight: ReviewPreflightMetadata;
  readonly agentCwd: string;
  readonly cleanup: () => Promise<void>;
};

export type PreparePrRepositoryViewParams = {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly installationToken: string;
};

async function fetchPullRequestShas(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ baseSha: string; headSha: string }> {
  const octokit = installationOctokit(token);
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return { baseSha: data.base.sha, headSha: data.head.sha };
}

export async function preparePrRepositoryView(
  params: PreparePrRepositoryViewParams,
): Promise<PrRepositoryView> {
  const shas = await fetchPullRequestShas(
    params.installationToken,
    params.owner,
    params.repo,
    params.prNumber,
  );
  const workspace = await prepareLocalPrWorkspace({
    cfg: params.cfg,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    baseSha: shas.baseSha,
    headSha: params.headSha,
    installationToken: params.installationToken,
  });
  return {
    workspace,
    preflight: buildReviewPreflightMetadataFromWorkspace(workspace),
    agentCwd: workspace.agentCwd,
    cleanup: () => workspace.cleanup(),
  };
}
