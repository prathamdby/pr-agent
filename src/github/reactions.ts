import { installationOctokit } from "./appAuth.js";

/** Octokit types `content` as literal union; `eyes` maps to 👀 in the UI. */
const EYES = "eyes" as const;

async function safeReact(fn: () => Promise<unknown>) {
	try {
		await fn();
	} catch (e: unknown) {
		const status = (e as { status?: number }).status;
		if (status === 422 || status === 403) return;
		throw e;
	}
}

export async function acknowledgeWithEyesOnIssue(apiToken: string, owner: string, repo: string, issueNumber: number) {
	const octokit = installationOctokit(apiToken);
	await safeReact(() =>
		octokit.rest.reactions.createForIssue({
			owner,
			repo,
			issue_number: issueNumber,
			content: EYES,
		}),
	);
}

export async function acknowledgeWithEyesOnIssueComment(apiToken: string, owner: string, repo: string, commentId: number) {
	const octokit = installationOctokit(apiToken);
	await safeReact(() =>
		octokit.rest.reactions.createForIssueComment({
			owner,
			repo,
			comment_id: commentId,
			content: EYES,
		}),
	);
}

export async function acknowledgeWithEyesOnPullReviewComment(
	apiToken: string,
	owner: string,
	repo: string,
	commentId: number,
) {
	const octokit = installationOctokit(apiToken);
	await safeReact(() =>
		octokit.rest.reactions.createForPullRequestReviewComment({
			owner,
			repo,
			comment_id: commentId,
			content: EYES,
		}),
	);
}
