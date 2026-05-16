import type { Config } from "../../config.js";
import { createGithubBot } from "../../github/botFacade.js";
import { parseSlashCommand } from "../../commands/parseSlashCommand.js";
import {
	handleHelpIssueThread,
	handleReviewCommand,
	postEphemeralIssueNote,
} from "../../commands/registry.js";
import type { IssueCommentWebhookPayload } from "../payloads/issueCommentEvent.js";

export type IssueCommentHandlerDeps = {
	botUserId: number;
};

export async function handleIssueCommentEvent(
	cfg: Config,
	token: string,
	data: IssueCommentWebhookPayload,
	deps: IssueCommentHandlerDeps,
): Promise<void> {
	if (data.action !== "created") return;

	const owner = data.repository.owner.login;
	const name = data.repository.name;
	const prNumber = data.issue.number;
	const comment = data.comment;
	const body = comment.body ?? "";

	if (comment.user.id === deps.botUserId) return;

	const command = parseSlashCommand(body);
	if (!command) return;

	const bot = createGithubBot(token);

	await Promise.all([
		bot.acknowledgeWithEyesOnIssue(owner, name, prNumber),
		bot.acknowledgeWithEyesOnIssueComment(owner, name, comment.id),
	]);

	const headSha = await bot.getPullRequestHeadSha(owner, name, prNumber);

	if (command === "help") {
		await handleHelpIssueThread(token, owner, name, prNumber);
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

	await postEphemeralIssueNote(token, owner, name, prNumber, `Unknown command \`/${command}\`. Try \`/help\` for available commands.`);
}
