import { installationOctokit } from "../github/appAuth.js";
import { httpStatus } from "../github/httpStatus.js";

export type PullRequestBranchContext = {
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepoFullName: string;
  readonly baseRef: string;
  readonly baseRepoFullName: string;
  readonly baseOwner: string;
  readonly baseRepo: string;
};

export type RepositoryPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export async function getPullRequestBranchContext(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequestBranchContext> {
  const octokit = installationOctokit(token);
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const headRepoFullName = data.head.repo?.full_name;
  const baseRepoFullName = data.base.repo?.full_name;
  if (!headRepoFullName || !baseRepoFullName) {
    throw new Error("Pull request branch repository metadata is unavailable");
  }
  return {
    headSha: data.head.sha,
    headRef: data.head.ref,
    headRepoFullName,
    baseRef: data.base.ref,
    baseRepoFullName,
    baseOwner: data.base.repo.owner.login,
    baseRepo: data.base.repo.name,
  };
}

export async function getRepositoryPermission(
  token: string,
  owner: string,
  repo: string,
  username: string,
): Promise<RepositoryPermission> {
  const octokit = installationOctokit(token);
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    return data.permission as RepositoryPermission;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404) return "none";
    throw error;
  }
}

export function permissionCanAutoFix(permission: RepositoryPermission): boolean {
  return permission === "write" || permission === "maintain" || permission === "admin";
}

export async function createOrReuseFallbackPullRequest(
  token: string,
  params: {
    owner: string;
    repo: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  },
): Promise<{ number: number; url: string; reused: boolean }> {
  const octokit = installationOctokit(token);
  const head = `${params.owner}:${params.headBranch}`;
  const existing = await octokit.rest.pulls.list({
    owner: params.owner,
    repo: params.repo,
    state: "open",
    head,
    base: params.baseBranch,
    per_page: 1,
  });
  const prior = existing.data[0];
  if (prior) {
    return { number: prior.number, url: prior.html_url, reused: true };
  }
  const { data } = await octokit.rest.pulls.create({
    owner: params.owner,
    repo: params.repo,
    title: params.title,
    body: params.body,
    head: params.headBranch,
    base: params.baseBranch,
  });
  return { number: data.number, url: data.html_url, reused: false };
}

export async function getBranchHeadSha(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const octokit = installationOctokit(token);
  try {
    const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
    return data.commit.sha;
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw error;
  }
}

export async function isCommitReachableFromHead(
  token: string,
  owner: string,
  repo: string,
  ancestorSha: string,
  headSha: string,
): Promise<boolean> {
  if (ancestorSha === headSha) return true;
  const octokit = installationOctokit(token);
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${ancestorSha}...${headSha}`,
    });
    return data.status === "ahead" || data.status === "identical";
  } catch (error) {
    if (httpStatus(error) === 404) return false;
    throw error;
  }
}
