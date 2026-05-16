import { postIssueComment, replyToPullReviewComment } from "./comments.js";
import { getPullRequestHeadSha } from "./prMeta.js";
import {
	acknowledgeWithEyesOnIssue,
	acknowledgeWithEyesOnIssueComment,
	acknowledgeWithEyesOnPullReviewComment,
} from "./reactions.js";

/**
 * Side-effect helpers used by webhook handlers (reactions, PR head SHA, comments).
 * Installation auth and bot identity live behind Effect services in {@link ../effect/services/}.
 */
export function createGithubBot(apiToken: string) {
	return {
		acknowledgeWithEyesOnIssue: (owner: string, repo: string, issueNumber: number) =>
			acknowledgeWithEyesOnIssue(apiToken, owner, repo, issueNumber),

		acknowledgeWithEyesOnIssueComment: (owner: string, repo: string, commentId: number) =>
			acknowledgeWithEyesOnIssueComment(apiToken, owner, repo, commentId),

		acknowledgeWithEyesOnPullReviewComment: (owner: string, repo: string, commentId: number) =>
			acknowledgeWithEyesOnPullReviewComment(apiToken, owner, repo, commentId),

		getPullRequestHeadSha: (owner: string, repo: string, prNumber: number) =>
			getPullRequestHeadSha(apiToken, owner, repo, prNumber),

		postIssueComment: (owner: string, repo: string, issueNumber: number, body: string) =>
			postIssueComment(apiToken, owner, repo, issueNumber, body),

		replyToPullReviewComment: (
			owner: string,
			repo: string,
			pullNumber: number,
			inReplyToCommentId: number,
			body: string,
		) => replyToPullReviewComment(apiToken, owner, repo, pullNumber, inReplyToCommentId, body),
	};
}

export type GithubBot = ReturnType<typeof createGithubBot>;
