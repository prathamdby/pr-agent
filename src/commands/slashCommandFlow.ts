import { Effect } from "effect";
import type { Config } from "../config.js";
import { runFullPrReview } from "../agent/reviewRun.js";
import { runQueuedReview } from "../agent/reviewQueue.js";
import { PrGithubSurface } from "../effect/services/prGithubSurface.js";
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
	"- `/review` — re-run a full review using the current PR head commit",
	"",
	"Notes:",
	"- Automated reviews also run on PR `opened` / `synchronize` / `reopened`.",
	"- Edited comments are ignored for slash parsing in v1.",
].join("\n");

export function runSlashCommandFlow(ctx: SlashContext): Effect.Effect<void, Error, PrGithubSurface> {
	return Effect.gen(function* () {
		if (ctx.commenterId === ctx.botUserId) return;

		const command = parseSlashCommand(ctx.body);
		if (!command) return;

		const surface = yield* PrGithubSurface;

		const ackTriggeringComment =
			ctx.replyTarget.kind === "prConversation"
				? surface.acknowledgeOnIssueComment(ctx.token, ctx.owner, ctx.repo, ctx.commentId)
				: surface.acknowledgeOnReviewComment(ctx.token, ctx.owner, ctx.repo, ctx.commentId);

		const postReply = (body: string): Effect.Effect<void, Error> =>
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
		yield* ackTriggeringComment;

		const headSha = yield* surface.getPullRequestHeadSha(
			ctx.token,
			ctx.owner,
			ctx.repo,
			ctx.replyTarget.prNumber,
		);

		if (command === "help") {
			yield* postReply(helpBody);
			return;
		}

		if (command === "review") {
			yield* Effect.tryPromise({
				try: () =>
					runQueuedReview(`${ctx.owner}/${ctx.repo}#${ctx.replyTarget.prNumber}:slash`, () =>
						runFullPrReview({
							cfg: ctx.cfg,
							token: ctx.token,
							owner: ctx.owner,
							repo: ctx.repo,
							prNumber: ctx.replyTarget.prNumber,
							headSha,
							userSupplement: `User invoked /review with:\n${ctx.body}`,
						}),
					).then(() => undefined),
				catch: (e) => (e instanceof Error ? e : new Error(String(e))),
			});
			return;
		}

		yield* postReply(`Unknown command \`/${command}\`. Try \`/help\` for available commands.`);
	});
}
