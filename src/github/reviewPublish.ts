import { installationOctokit } from "./appAuth.js";
import { REVIEW_SUMMARY_SENTINEL } from "../agent/reviewSchema.js";

export type InlineReviewComment = {
	path: string;
	line: number;
	side: "RIGHT";
	body: string;
};

export async function createPullRequestReviewWithComments(
	token: string,
	owner: string,
	repo: string,
	pullNumber: number,
	params: {
		body: string;
		event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
		comments?: InlineReviewComment[];
	},
): Promise<{ id: number; url: string }> {
	const octokit = installationOctokit(token);
	const { data } = await octokit.rest.pulls.createReview({
		owner,
		repo,
		pull_number: pullNumber,
		body: params.body,
		event: params.event,
		comments: params.comments,
	});
	return { id: data.id, url: data.html_url };
}

export async function findIssueCommentBySentinel(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
	sentinel: string,
): Promise<{ id: number } | null> {
	const octokit = installationOctokit(token);
	const { data } = await octokit.rest.issues.listComments({
		owner,
		repo,
		issue_number: issueNumber,
		per_page: 100,
	});
	const hit = data.find((c) => (c.body ?? "").startsWith(sentinel));
	return hit ? { id: hit.id } : null;
}

export async function createIssueComment(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<{ id: number; url: string }> {
	const octokit = installationOctokit(token);
	const { data } = await octokit.rest.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body,
	});
	return { id: data.id, url: data.html_url };
}

export async function updateIssueComment(
	token: string,
	owner: string,
	repo: string,
	commentId: number,
	body: string,
): Promise<void> {
	const octokit = installationOctokit(token);
	await octokit.rest.issues.updateComment({
		owner,
		repo,
		comment_id: commentId,
		body,
	});
}

export async function upsertReviewSummaryComment(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
	body: string,
	sentinel: string = REVIEW_SUMMARY_SENTINEL,
): Promise<{ id: number; updated: boolean }> {
	const existing = await findIssueCommentBySentinel(token, owner, repo, prNumber, sentinel);
	if (existing) {
		await updateIssueComment(token, owner, repo, existing.id, body);
		return { id: existing.id, updated: true };
	}
	const created = await createIssueComment(token, owner, repo, prNumber, body);
	return { id: created.id, updated: false };
}

export async function listPullRequestLabels(
	token: string,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<string[]> {
	const octokit = installationOctokit(token);
	const { data } = await octokit.rest.issues.listLabelsOnIssue({
		owner,
		repo,
		issue_number: pullNumber,
	});
	return data.map((l) => l.name);
}

export async function setPullRequestLabels(
	token: string,
	owner: string,
	repo: string,
	pullNumber: number,
	labels: string[],
): Promise<void> {
	const octokit = installationOctokit(token);
	await octokit.rest.issues.setLabels({
		owner,
		repo,
		issue_number: pullNumber,
		labels,
	});
}
