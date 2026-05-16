import { postIssueComment, replyToPullReviewComment } from "../github/comments.js";
import { runFullPrReview } from "../agent/reviewRun.js";
import { runQueuedReview } from "../agent/reviewQueue.js";
import type { Config } from "../config.js";

const helpBody = [
	"### PR Agent help",
	"",
	"Commands (first line of a **new** comment):",
	"- `/help` — show this message",
	"- `/review` — re-run a full review using the current PR head commit",
	"",
	"Notes:",
	"- Automated reviews also run on PR `opened` / `synchronize` / `reopened`.",
	"- Edited comments are ignored for slash parsing in v1.",
].join("\n");

export async function handleHelpIssueThread(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
) {
	await postIssueComment(token, owner, repo, issueNumber, helpBody);
}

export async function handleHelpReviewThread(
	token: string,
	owner: string,
	repo: string,
	pullNumber: number,
	inReplyToCommentId: number,
) {
	await replyToPullReviewComment(token, owner, repo, pullNumber, inReplyToCommentId, helpBody);
}

export async function handleReviewCommand(params: {
	cfg: Config;
	token: string;
	owner: string;
	repo: string;
	prNumber: number;
	headSha: string;
	commandBody: string;
}) {
	const { cfg, token, owner, repo, prNumber, headSha, commandBody } = params;
	await runQueuedReview(`${owner}/${repo}#${prNumber}:slash`, () =>
		runFullPrReview({
			cfg,
			token,
			owner,
			repo,
			prNumber,
			headSha,
			userSupplement: `User invoked /review with:\n${commandBody}`,
		}),
	);
}

export async function postEphemeralIssueNote(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
) {
	await postIssueComment(token, owner, repo, issueNumber, body);
}

export async function postEphemeralReviewReply(
	token: string,
	owner: string,
	repo: string,
	pullNumber: number,
	inReplyToCommentId: number,
	body: string,
) {
	await replyToPullReviewComment(token, owner, repo, pullNumber, inReplyToCommentId, body);
}
