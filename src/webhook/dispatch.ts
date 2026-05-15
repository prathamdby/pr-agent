import type { Config } from "../config.js";
import { deliveryDedupeKey, isDuplicateDelivery } from "../deliveryDedupe.js";
import { getInstallationToken } from "../github/appAuth.js";
import { log } from "../log.js";
import { WebhookParseError, parseGithubPayload, parseInstallationId } from "./parseGithubPayload.js";
import { handleIssueCommentEvent } from "./handlers/issueComment.js";
import { handlePullRequestEvent } from "./handlers/pullRequest.js";
import { handlePullRequestReviewCommentEvent } from "./handlers/pullRequestReviewComment.js";

export async function dispatchGithubEvent(
	cfg: Config,
	headers: { delivery?: string; event?: string; rawBody: Buffer },
	payload: Record<string, unknown>,
) {
	const event = headers.event ?? "";

	if (!headers.delivery) {
		log.warn("missing_delivery_id_using_body_hash");
	}

	let parsed;
	try {
		parsed = parseGithubPayload(event, payload);
	} catch (e) {
		if (e instanceof WebhookParseError) {
			log.warn("webhook_parse_error", { event, message: e.message });
			return;
		}
		throw e;
	}

	const dedupeKey = deliveryDedupeKey(headers.delivery, headers.rawBody);
	if (isDuplicateDelivery(dedupeKey)) {
		log.info("deduped_delivery", { dedupeKey, event });
		return;
	}

	const installationId =
		parsed.name === "ignored" ? parseInstallationId(parsed.data) : parsed.data.installation.id;

	if (!installationId) {
		log.warn("missing_installation_id", { event });
		return;
	}

	const token = await getInstallationToken(cfg, installationId);

	switch (parsed.name) {
		case "pull_request":
			await handlePullRequestEvent(cfg, token, parsed.data);
			break;
		case "issue_comment":
			await handleIssueCommentEvent(cfg, token, parsed.data);
			break;
		case "pull_request_review_comment":
			await handlePullRequestReviewCommentEvent(cfg, token, parsed.data);
			break;
		case "ignored":
			log.debug("ignored_event", { event });
			break;
	}
}
