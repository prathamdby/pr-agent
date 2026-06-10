import { getAppBotIdentity, installationOctokit } from "../github/appAuth.js";
import type { PullRequestForFileList } from "../github/listPullRequestFiles.js";
import { GITHUB_REACTION_EYES } from "../settings/index.js";
import type { AckJobData, AckTarget } from "./types.js";
import type { ReplyTarget } from "../commands/replyTarget.js";
import { httpStatus } from "../github/httpStatus.js";

export type PullRequestHeadResolution = {
  readonly headSha: string;
  readonly pullRequest: PullRequestForFileList;
};

export async function getPullRequestHead(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequestHeadResolution> {
  const octokit = installationOctokit(token);
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return { headSha: data.head.sha, pullRequest: data };
}

export async function getPullRequestHeadSha(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  return (await getPullRequestHead(token, owner, repo, prNumber)).headSha;
}

export async function safeReaction(
  token: string,
  owner: string,
  repo: string,
  target: AckTarget,
): Promise<void> {
  const octokit = installationOctokit(token);
  try {
    if (target.kind === "pr") {
      await octokit.rest.reactions.createForIssue({
        owner,
        repo,
        issue_number: target.prNumber,
        content: GITHUB_REACTION_EYES,
      });
    } else if (target.kind === "issueComment") {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: target.commentId,
        content: GITHUB_REACTION_EYES,
      });
    } else {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: target.commentId,
        content: GITHUB_REACTION_EYES,
      });
    }
  } catch (e: unknown) {
    const status = httpStatus(e);
    if (status === 422 || status === 403) return;
    throw e;
  }
}

export async function postSlashReply(
  token: string,
  owner: string,
  repo: string,
  target: ReplyTarget,
  body: string,
): Promise<void> {
  const octokit = installationOctokit(token);
  if (target.kind === "inlineReviewThread") {
    await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: target.prNumber,
      comment_id: target.inReplyToCommentId,
      body,
    });
    return;
  }
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: target.prNumber,
    body,
  });
}

export async function postAckReply(token: string, data: AckJobData, body: string): Promise<void> {
  const target = data.reply?.target;
  if (!target) return;
  await postSlashReply(token, data.owner, data.repo, target, body);
}

export { getAppBotIdentity };
