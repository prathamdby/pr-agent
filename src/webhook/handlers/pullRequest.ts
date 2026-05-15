import type { Config } from "../../config.js";
import { runFullPrReview } from "../../agent/reviewRun.js";
import { createGithubBot } from "../../github/botFacade.js";
import { log } from "../../log.js";
import type { PullRequestWebhookPayload } from "../payloads/pullRequestEvent.js";

const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export async function handlePullRequestEvent(cfg: Config, token: string, data: PullRequestWebhookPayload): Promise<void> {
	const action = data.action;
	if (!action || !AUTOMATED_PR_ACTIONS.has(action)) return;

	const owner = data.repository.owner.login;
	const name = data.repository.name;
	const pr = data.pull_request;
	const bot = createGithubBot(token);

	await Promise.all([bot.acknowledgeWithEyesOnIssue(owner, name, pr.number)]);

	log.info("run_automated_review", { owner, repo: name, pr: pr.number, action });
	await runFullPrReview({
		cfg,
		token,
		owner,
		repo: name,
		prNumber: pr.number,
		headSha: pr.head.sha,
	});
}
