import { Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import type { CodeAnchor } from "../../agent/askRun.js";
import { parseSlashCommand } from "../../commands/parseSlashCommand.js";
import { AgentWorkScheduler } from "../../agentWork/scheduler.js";
import type { WebhookHeaders } from "../../agentWork/types.js";
import type { ParsedGithubEvent } from "../../webhook/parseGithubPayload.js";
import { BotIdentity, BotIdentityLive } from "./botIdentity.js";

type PullRequestData = Extract<ParsedGithubEvent, { name: "pull_request" }>["data"];
type IssueCommentData = Extract<ParsedGithubEvent, { name: "issue_comment" }>["data"];
type PullRequestReviewCommentData = Extract<ParsedGithubEvent, { name: "pull_request_review_comment" }>["data"];

function codeAnchorFromReviewComment(
	comment: PullRequestReviewCommentData["comment"],
): CodeAnchor | undefined {
	if (comment.path == null || comment.line == null) return undefined;
	return {
		path: comment.path,
		line: comment.line,
		startLine: comment.start_line ?? undefined,
		side: comment.side,
		diffHunk: comment.diff_hunk,
	};
}

export class WebhookHandlers extends Context.Tag("WebhookHandlers")<
	WebhookHandlers,
	{
		readonly pullRequest: (cfg: Config, headers: WebhookHeaders, data: PullRequestData) => Effect.Effect<void, Error>;
		readonly issueComment: (cfg: Config, headers: WebhookHeaders, data: IssueCommentData) => Effect.Effect<void, Error>;
		readonly pullRequestReviewComment: (
			cfg: Config,
			headers: WebhookHeaders,
			data: PullRequestReviewCommentData,
		) => Effect.Effect<void, Error>;
	}
>() {}

export const WebhookHandlersCore = Layer.effect(
	WebhookHandlers,
	Effect.gen(function* () {
		const scheduler = yield* AgentWorkScheduler;
		const bot = yield* BotIdentity;

		const ignoreBotSlash = (cfg: Config, headers: WebhookHeaders, commenterId: number) =>
			Effect.gen(function* () {
				const botUserId = yield* bot.getAppUserId(cfg);
				if (commenterId !== botUserId) return false;
				yield* scheduler.recordIgnored(headers, "ignored_bot_slash_command");
				return true;
			});

		return WebhookHandlers.of({
			pullRequest: (_cfg, headers, data) =>
				scheduler.submitAutomatedReview(
					headers,
					{
						owner: data.repository.owner.login,
						repo: data.repository.name,
						prNumber: data.pull_request.number,
						headSha: data.pull_request.head.sha,
						installationId: data.installation.id,
					},
					data.action ?? "",
				),

			issueComment: (cfg, headers, data) =>
				Effect.gen(function* () {
					if (data.action !== "created") {
						yield* scheduler.recordIgnored(headers, `ignored_issue_comment_${data.action}`);
						return;
					}
					const body = data.comment.body ?? "";
					if (!parseSlashCommand(body)) {
						yield* scheduler.recordIgnored(headers, "ignored_no_slash_command");
						return;
					}
					if (yield* ignoreBotSlash(cfg, headers, data.comment.user.id)) return;

					yield* scheduler.submitSlashCommand({
						headers,
						installationId: data.installation.id,
						owner: data.repository.owner.login,
						repo: data.repository.name,
						prNumber: data.issue.number,
						commenterId: data.comment.user.id,
						commentId: data.comment.id,
						body,
						replyTarget: { kind: "prConversation", prNumber: data.issue.number },
					});
				}),

			pullRequestReviewComment: (cfg, headers, data) =>
				Effect.gen(function* () {
					if (data.action !== "created") {
						yield* scheduler.recordIgnored(headers, `ignored_review_comment_${data.action}`);
						return;
					}
					const body = data.comment.body ?? "";
					if (!parseSlashCommand(body)) {
						yield* scheduler.recordIgnored(headers, "ignored_no_slash_command");
						return;
					}
					if (yield* ignoreBotSlash(cfg, headers, data.comment.user.id)) return;

					yield* scheduler.submitSlashCommand({
						headers,
						installationId: data.installation.id,
						owner: data.repository.owner.login,
						repo: data.repository.name,
						prNumber: data.pull_request.number,
						commenterId: data.comment.user.id,
						commentId: data.comment.id,
						body,
						replyTarget: {
							kind: "inlineReviewThread",
							prNumber: data.pull_request.number,
							inReplyToCommentId: data.comment.id,
						},
						codeAnchor: codeAnchorFromReviewComment(data.comment),
					});
				}),
		});
	}),
);

export const WebhookHandlersLive = WebhookHandlersCore.pipe(Layer.provide(BotIdentityLive));
