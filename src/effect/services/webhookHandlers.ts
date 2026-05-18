import { Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import { runFullPrReview } from "../../agent/reviewRun.js";
import type { InstallationToken } from "../../github/appAuth.js";
import { parseSlashCommand } from "../../commands/parseSlashCommand.js";
import { runSlashCommandFlow } from "../../commands/slashCommandFlow.js";
import { log } from "../../log.js";
import type { ParsedGithubEvent } from "../../webhook/parseGithubPayload.js";
import { BotIdentity, BotIdentityLive } from "./botIdentity.js";
import { PrGithubSurface, PrGithubSurfaceLive } from "./prGithubSurface.js";
import { ReviewQueue } from "./reviewQueue.js";

type PullRequestData = Extract<ParsedGithubEvent, { name: "pull_request" }>["data"];
type IssueCommentData = Extract<ParsedGithubEvent, { name: "issue_comment" }>["data"];
type PullRequestReviewCommentData = Extract<ParsedGithubEvent, { name: "pull_request_review_comment" }>["data"];

const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export class WebhookHandlers extends Context.Tag("WebhookHandlers")<
	WebhookHandlers,
	{
		readonly pullRequest: (cfg: Config, installation: InstallationToken, data: PullRequestData) => Effect.Effect<void, Error>;
		readonly issueComment: (cfg: Config, installation: InstallationToken, data: IssueCommentData) => Effect.Effect<void, Error>;
		readonly pullRequestReviewComment: (
			cfg: Config,
			installation: InstallationToken,
			data: PullRequestReviewCommentData,
		) => Effect.Effect<void, Error>;
	}
>() {}

export const WebhookHandlersCore = Layer.effect(
	WebhookHandlers,
	Effect.gen(function* () {
		const botIdentity = yield* BotIdentity;
		const surface = yield* PrGithubSurface;
		const reviewQueue = yield* ReviewQueue;

		return WebhookHandlers.of({
			pullRequest: (cfg, installation, data) =>
				Effect.gen(function* () {
					const action = data.action;
					if (!action || !AUTOMATED_PR_ACTIONS.has(action)) return;

					const owner = data.repository.owner.login;
					const repo = data.repository.name;
					const prNumber = data.pull_request.number;
					const headSha = data.pull_request.head.sha;
					const { token, expiresAtTs: tokenExpiresAtTs, ttlMs: tokenTtlMs } = installation;

					yield* surface.acknowledgeOnPrConversation(token, owner, repo, prNumber);

					log.info("run_automated_review", { owner, repo, pr: prNumber, action });

					yield* reviewQueue.submit(
						`${owner}/${repo}#${prNumber}:auto`,
						Effect.tryPromise({
							try: () =>
								runFullPrReview({
									cfg,
									token,
									tokenExpiresAtTs,
									tokenTtlMs,
									owner,
									repo,
									prNumber,
									headSha,
								}).then((result) => {
									if (!result.published) {
										log.warn("review_not_published", {
											owner,
											repo,
											pr: prNumber,
											publishAttempts: result.publishAttempts,
										});
									}
								}),
							catch: (e) => (e instanceof Error ? e : new Error(String(e))),
						}),
					);
				}),

			issueComment: (cfg, installation, data) =>
				Effect.gen(function* () {
					if (data.action !== "created") return;
					const body = data.comment.body ?? "";
					if (!parseSlashCommand(body)) return;

					const { token, expiresAtTs: tokenExpiresAtTs, ttlMs: tokenTtlMs } = installation;
					const botUserId = yield* botIdentity.getUserId(cfg, token);

					yield* runSlashCommandFlow({
						cfg,
						token,
						tokenExpiresAtTs,
						tokenTtlMs,
						owner: data.repository.owner.login,
						repo: data.repository.name,
						botUserId,
						commenterId: data.comment.user.id,
						commentId: data.comment.id,
						body,
						replyTarget: { kind: "prConversation", prNumber: data.issue.number },
					}).pipe(
						Effect.provideService(PrGithubSurface, surface),
						Effect.provideService(ReviewQueue, reviewQueue),
					);
				}),

			pullRequestReviewComment: (cfg, installation, data) =>
				Effect.gen(function* () {
					if (data.action !== "created") return;
					const body = data.comment.body ?? "";
					if (!parseSlashCommand(body)) return;

					const { token, expiresAtTs: tokenExpiresAtTs, ttlMs: tokenTtlMs } = installation;
					const botUserId = yield* botIdentity.getUserId(cfg, token);

					yield* runSlashCommandFlow({
						cfg,
						token,
						tokenExpiresAtTs,
						tokenTtlMs,
						owner: data.repository.owner.login,
						repo: data.repository.name,
						botUserId,
						commenterId: data.comment.user.id,
						commentId: data.comment.id,
						body,
						replyTarget: {
							kind: "inlineReviewThread",
							prNumber: data.pull_request.number,
							inReplyToCommentId: data.comment.id,
						},
					}).pipe(
						Effect.provideService(PrGithubSurface, surface),
						Effect.provideService(ReviewQueue, reviewQueue),
					);
				}),
		});
	}),
);

export const WebhookHandlersLive = WebhookHandlersCore.pipe(
	Layer.provide(BotIdentityLive),
	Layer.provide(PrGithubSurfaceLive),
);
