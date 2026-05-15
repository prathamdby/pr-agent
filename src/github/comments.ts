import { installationOctokit } from "./appAuth.js";

export async function postIssueComment(apiToken: string, owner: string, repo: string, issueNumber: number, body: string) {
	const octokit = installationOctokit(apiToken);
	await octokit.rest.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body,
	});
}

export async function replyToPullReviewComment(
	apiToken: string,
	owner: string,
	repo: string,
	pullNumber: number,
	inReplyToCommentId: number,
	body: string,
) {
	const octokit = installationOctokit(apiToken);
	await octokit.rest.pulls.createReplyForReviewComment({
		owner,
		repo,
		pull_number: pullNumber,
		comment_id: inReplyToCommentId,
		body,
	});
}
