import { createHash } from "node:crypto";

export type GitHubPullRequestFileContext = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
};

/** Anchor id for a file row on the PR "Files changed" tab (SHA-256 of the repo path). */
export function githubPullRequestFileDiffAnchor(filePath: string): string {
  const digest = createHash("sha256").update(filePath).digest("hex");
  return `diff-${digest}`;
}

/** Link to a file's diff hunk on the pull request Files changed tab. */
export function githubPullRequestFileDiffUrl(
  ctx: GitHubPullRequestFileContext,
  filePath: string,
): string {
  const anchor = githubPullRequestFileDiffAnchor(filePath);
  return `https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}/files#${anchor}`;
}
