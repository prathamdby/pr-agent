import { getAppBotIdentity, installationOctokit } from "../github/appAuth.js";
import type { PullRequestForFileList } from "../github/listPullRequestFiles.js";
import { logDebug } from "../evlog.js";
import { GITHUB_REACTION_EYES, type GithubReactionContent } from "../settings/index.js";
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
  expiresAtTs?: number,
): Promise<PullRequestHeadResolution> {
  const octokit = installationOctokit(token, expiresAtTs);
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
  expiresAtTs?: number,
): Promise<string> {
  return (await getPullRequestHead(token, owner, repo, prNumber, expiresAtTs)).headSha;
}

export async function safeReaction(
  token: string,
  owner: string,
  repo: string,
  target: AckTarget,
  content: GithubReactionContent = GITHUB_REACTION_EYES,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  try {
    if (target.kind === "pr") {
      await octokit.rest.reactions.createForIssue({
        owner,
        repo,
        issue_number: target.prNumber,
        content,
      });
    } else if (target.kind === "issueComment") {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: target.commentId,
        content,
      });
    } else {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: target.commentId,
        content,
      });
    }
  } catch (e: unknown) {
    const status = httpStatus(e);
    if (status === 403) {
      logDebug("reaction_suppressed_forbidden", {
        owner,
        repo,
        target,
        reaction: content,
        status,
      });
      return;
    }
    if (status === 422) return;
    throw e;
  }
}

/** Post one reaction to each target; per-target failures are logged and do not abort siblings. */
export async function reactOnAckTargets(
  token: string,
  owner: string,
  repo: string,
  targets: readonly AckTarget[],
  content: GithubReactionContent,
  expiresAtTs?: number,
): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      try {
        await safeReaction(token, owner, repo, target, content, expiresAtTs);
      } catch (e) {
        logDebug("ack_reaction_failed", {
          owner,
          repo,
          targetKind: target.kind,
          reaction: content,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
}

export async function postSlashReply(
  token: string,
  owner: string,
  repo: string,
  target: ReplyTarget,
  body: string,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
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

export async function postAckReply(
  token: string,
  data: AckJobData,
  body: string,
  expiresAtTs?: number,
): Promise<void> {
  const target = data.reply?.target;
  if (!target) return;
  await postSlashReply(token, data.owner, data.repo, target, body, expiresAtTs);
}

export { getAppBotIdentity };
