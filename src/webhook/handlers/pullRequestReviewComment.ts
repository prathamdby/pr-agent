import type { Config } from "../../config.js";
import { getBotUserId } from "../../github/appAuth.js";
import { createGithubBot } from "../../github/botFacade.js";
import { parseSlashCommand } from "../../commands/parseSlashCommand.js";
import {
	handleHelpReviewThread,
	handleReviewCommand,
	postEphemeralReviewReply,
} from "../../commands/registry.js";
import type { PullRequestReviewCommentWebhookPayload } from "../payloads/pullRequestReviewCommentEvent.js";

export async function handlePullRequestReviewCommentEvent(
	cfg: Config,
	token: string,
	data: PullRequestReviewCommentWebhookPayload,
): Promise<void> {
	if (data.action !== "created") return;

	const owner = data.repository.owner.login;
	const name = data.repository.name;
	const prNumber = data.pull_request.number;
	const comment = data.comment;
	const body = comment.body ?? "";

	const botId = await getBotUserId(token, cfg.githubAppId);
	if (comment.user.id === botId) return;

	const command = parseSlashCommand(body);
	if (!command) return;

	const bot = createGithubBot(token);

	await Promise.all([
		bot.acknowledgeWithEyesOnIssue(owner, name, prNumber),
		bot.acknowledgeWithEyesOnPullReviewComment(owner, name, comment.id),
	]);

	const headSha = await bot.getPullRequestHeadSha(owner, name, prNumber);

	if (command === "help") {
		await handleHelpReviewThread(token, owner, name, prNumber, comment.id);
		return;
	}
	if (command === "review") {
		await handleReviewCommand({
			cfg,
			token,
			owner,
			repo: name,
			prNumber,
			headSha,
			commandBody: body,
		});
		return;
	}

	await postEphemeralReviewReply(
		token,
		owner,
		name,
		prNumber,
		comment.id,
		`Unknown command \`/${command}\`. Try \`/help\` for available commands.`,
	);
}
