import { Effect } from "effect";
import type { Config } from "../config.js";
import { runFullPrReview } from "../agent/reviewRun.js";
import { PrGithubSurface } from "../effect/services/prGithubSurface.js";
import { log } from "../log.js";
import { ReviewQueue } from "../effect/services/reviewQueue.js";
import { parseSlashCommand } from "./parseSlashCommand.js";

export type ReplyTarget =
	| { readonly kind: "prConversation"; readonly prNumber: number }
	| {
		readonly kind: "inlineReviewThread";
		readonly prNumber: number;
		readonly inReplyToCommentId: number;
	};

export type SlashContext = {
	readonly cfg: Config;
	readonly token: string;
	readonly tokenExpiresAtTs: number;
	readonly tokenTtlMs: number;
	readonly owner: string;
	readonly repo: string;
	readonly botUserId: number;
	readonly commenterId: number;
	readonly commentId: number;
	readonly body: string;
	readonly replyTarget: ReplyTarget;
};

const helpBody = [
	"### PR Agent help",
	"",
	"Commands (first line of a **new** comment):",
	"- `/help` — show this message",
	"- `/review` — general bug-and-correctness review (also runs automatically on PR open/sync)",
	"- `/review-security` — deep security review (DeepSec-style; trigger-only, not auto-run)",
	"",
	"Notes:",
	"- Automated reviews use `/review`'s lens on PR `opened` / `synchronize` / `reopened`.",
	"- `/review` and `/review-security` can both leave summary comments on the same PR (different sentinels).",
	"- Some security issues may appear in both passes; pick the command that matches your question.",
	"- Edited comments are ignored for slash parsing in v1.",
].join("\n");

export function runSlashCommandFlow(
	ctx: SlashContext,
): Effect.Effect<void, Error, PrGithubSurface | ReviewQueue> {
	return Effect.gen(function* () {
		if (ctx.commenterId === ctx.botUserId) return;

		const command = parseSlashCommand(ctx.body);
		if (!command) return;

		const surface = yield* PrGithubSurface;

		const postReply = (body: string) =>
			ctx.replyTarget.kind === "prConversation"
				? surface.postPrConversationComment(ctx.token, ctx.owner, ctx.repo, ctx.replyTarget.prNumber, body)
				: surface.replyOnInlineReviewThread(
					ctx.token,
					ctx.owner,
					ctx.repo,
					ctx.replyTarget.prNumber,
					ctx.replyTarget.inReplyToCommentId,
					body,
				);

		yield* surface.acknowledgeOnPrConversation(ctx.token, ctx.owner, ctx.repo, ctx.replyTarget.prNumber);
		yield* ctx.replyTarget.kind === "prConversation"
			? surface.acknowledgeOnIssueComment(ctx.token, ctx.owner, ctx.repo, ctx.commentId)
			: surface.acknowledgeOnReviewComment(ctx.token, ctx.owner, ctx.repo, ctx.commentId);

		if (command === "help") {
			yield* postReply(helpBody);
			return;
		}

		if (command === "review" || command === "review-security") {
			const headSha = yield* surface.getPullRequestHeadSha(
				ctx.token,
				ctx.owner,
				ctx.repo,
				ctx.replyTarget.prNumber,
			);
			const queueLabel =
				command === "review-security"
					? `${ctx.owner}/${ctx.repo}#${ctx.replyTarget.prNumber}:slash:security`
					: `${ctx.owner}/${ctx.repo}#${ctx.replyTarget.prNumber}:slash`;
			const reviewQueue = yield* ReviewQueue;
			yield* reviewQueue.submit(
				queueLabel,
				Effect.tryPromise({
					try: () =>
						runFullPrReview({
							cfg: ctx.cfg,
							token: ctx.token,
							tokenExpiresAtTs: ctx.tokenExpiresAtTs,
							tokenTtlMs: ctx.tokenTtlMs,
							owner: ctx.owner,
							repo: ctx.repo,
							prNumber: ctx.replyTarget.prNumber,
							headSha,
							mode: command,
							userSupplement: `User invoked /${command} with:\n${ctx.body}`,
						}).then((result) => {
							if (!result.published) {
								log.warn("review_not_published", {
									mode: command,
									owner: ctx.owner,
									repo: ctx.repo,
									pr: ctx.replyTarget.prNumber,
									publishAttempts: result.publishAttempts,
								});
							}
						}),
					catch: (e) => (e instanceof Error ? e : new Error(String(e))),
				}),
			);
			return;
		}

		yield* postReply(`Unknown command \`/${command}\`. Try \`/help\` for available commands.`);
	});
}
