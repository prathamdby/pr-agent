import { Context, Effect, Layer } from "effect";
import { reviewLabelsFromPayload, syncReviewLabels } from "../../agent/reviewLabels.js";
import type { ReviewPayload } from "../../agent/reviewSchema.js";
import { REVIEW_SUMMARY_SENTINEL } from "../../agent/reviewSchema.js";
import {
	listPullRequestLabels,
	setPullRequestLabels,
	upsertReviewSummaryComment,
} from "../../github/reviewPublish.js";
import { installationOctokit } from "../../github/appAuth.js";

const EYES = "eyes" as const;

function safeReact(thunk: () => Promise<unknown>): Effect.Effect<void, Error> {
	return Effect.tryPromise({
		try: async () => {
			try {
				await thunk();
			} catch (e: unknown) {
				const status = (e as { status?: number }).status;
				if (status === 422 || status === 403) return;
				throw e;
			}
		},
		catch: (e) => (e instanceof Error ? e : new Error(String(e))),
	});
}

function tryRest<A>(thunk: () => Promise<A>): Effect.Effect<A, Error> {
	return Effect.tryPromise({
		try: thunk,
		catch: (e) => (e instanceof Error ? e : new Error(String(e))),
	});
}

export class PrGithubSurface extends Context.Tag("PrGithubSurface")<
	PrGithubSurface,
	{
		readonly acknowledgeOnPrConversation: (
			apiToken: string,
			owner: string,
			repo: string,
			prNumber: number,
		) => Effect.Effect<void, Error>;
		readonly acknowledgeOnIssueComment: (
			apiToken: string,
			owner: string,
			repo: string,
			commentId: number,
		) => Effect.Effect<void, Error>;
		readonly acknowledgeOnReviewComment: (
			apiToken: string,
			owner: string,
			repo: string,
			commentId: number,
		) => Effect.Effect<void, Error>;
		readonly postPrConversationComment: (
			apiToken: string,
			owner: string,
			repo: string,
			prNumber: number,
			body: string,
		) => Effect.Effect<void, Error>;
		readonly replyOnInlineReviewThread: (
			apiToken: string,
			owner: string,
			repo: string,
			prNumber: number,
			inReplyToCommentId: number,
			body: string,
		) => Effect.Effect<void, Error>;
		readonly getPullRequestHeadSha: (
			apiToken: string,
			owner: string,
			repo: string,
			prNumber: number,
		) => Effect.Effect<string, Error>;
		readonly upsertReviewSummaryComment: (
			apiToken: string,
			owner: string,
			repo: string,
			prNumber: number,
			body: string,
		) => Effect.Effect<{ id: number; updated: boolean }, Error>;
		readonly syncReviewLabelsForPayload: (
			apiToken: string,
			owner: string,
			repo: string,
			prNumber: number,
			payload: ReviewPayload,
			opts: { effort: boolean; security: boolean },
		) => Effect.Effect<void, Error>;
	}
>() {}

export const PrGithubSurfaceLive = Layer.succeed(
	PrGithubSurface,
	PrGithubSurface.of({
		acknowledgeOnPrConversation: (apiToken, owner, repo, prNumber) =>
			safeReact(() => {
				const octokit = installationOctokit(apiToken);
				return octokit.rest.reactions.createForIssue({
					owner,
					repo,
					issue_number: prNumber,
					content: EYES,
				});
			}),

		acknowledgeOnIssueComment: (apiToken, owner, repo, commentId) =>
			safeReact(() => {
				const octokit = installationOctokit(apiToken);
				return octokit.rest.reactions.createForIssueComment({
					owner,
					repo,
					comment_id: commentId,
					content: EYES,
				});
			}),

		acknowledgeOnReviewComment: (apiToken, owner, repo, commentId) =>
			safeReact(() => {
				const octokit = installationOctokit(apiToken);
				return octokit.rest.reactions.createForPullRequestReviewComment({
					owner,
					repo,
					comment_id: commentId,
					content: EYES,
				});
			}),

		postPrConversationComment: (apiToken, owner, repo, prNumber, body) =>
			tryRest(async () => {
				const octokit = installationOctokit(apiToken);
				await octokit.rest.issues.createComment({
					owner,
					repo,
					issue_number: prNumber,
					body,
				});
			}),

		replyOnInlineReviewThread: (apiToken, owner, repo, prNumber, inReplyToCommentId, body) =>
			tryRest(async () => {
				const octokit = installationOctokit(apiToken);
				await octokit.rest.pulls.createReplyForReviewComment({
					owner,
					repo,
					pull_number: prNumber,
					comment_id: inReplyToCommentId,
					body,
				});
			}),

		getPullRequestHeadSha: (apiToken, owner, repo, prNumber) =>
			tryRest(async () => {
				const octokit = installationOctokit(apiToken);
				const { data } = await octokit.rest.pulls.get({
					owner,
					repo,
					pull_number: prNumber,
				});
				return data.head.sha;
			}),

		upsertReviewSummaryComment: (apiToken, owner, repo, prNumber, body) =>
			tryRest(() => upsertReviewSummaryComment(apiToken, owner, repo, prNumber, body, REVIEW_SUMMARY_SENTINEL)),

		syncReviewLabelsForPayload: (apiToken, owner, repo, prNumber, payload, opts) =>
			tryRest(async () => {
				if (!opts.effort && !opts.security) return;
				const current = await listPullRequestLabels(apiToken, owner, repo, prNumber);
				const managed = reviewLabelsFromPayload(payload, opts);
				const next = syncReviewLabels(current, managed);
				await setPullRequestLabels(apiToken, owner, repo, prNumber, next);
			}),
	}),
);
