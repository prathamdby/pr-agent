import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { publishReview } from "./publishReview.js";
import { reviewPayloadSchema, type ReviewPublishContext } from "./reviewSchema.js";

const DELIVERY_TOOL_NAMES = new Set(["createPullRequestReview", "addPullRequestComment"]);

export function filterReviewAgentTools<T extends { name: string }>(tools: T[]): T[] {
	return tools.filter((t) => !DELIVERY_TOOL_NAMES.has(t.name));
}

export function filterReviewAgentExecutors(
	executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
	const out: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
	for (const [name, fn] of Object.entries(executors)) {
		if (!DELIVERY_TOOL_NAMES.has(name)) out[name] = fn;
	}
	return out;
}

export type SubmitReviewState = {
	published: boolean;
	/** True after inline review is on GitHub; prevents duplicate reviews on retry. */
	inlinePublished: boolean;
	lastValidationError: string | null;
};

export function createSubmitReviewState(): SubmitReviewState {
	return { published: false, inlinePublished: false, lastValidationError: null };
}

export function buildSubmitReviewTool(params: {
	cfg: Config;
	token: string;
	ctx: ReviewPublishContext;
	state: SubmitReviewState;
}): {
	piTool: PiTool;
	executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
	const submitSchema = reviewPayloadSchema;

	const piTool: PiTool = {
		name: "submitReview",
		description:
			"Submit the completed structured review exactly once. Pass a ReviewPayload object matching the schema. This publishes inline review threads and the PR conversation summary; do not call createPullRequestReview or addPullRequestComment.",
		parameters: z.toJSONSchema(submitSchema, { unrepresentable: "any" }) as PiTool["parameters"],
	};

	const executor = async (args: Record<string, unknown>) => {
		if (params.state.published) {
			log.info("review_submit_duplicate_ignored", {
				owner: params.ctx.owner,
				repo: params.ctx.repo,
				pr: params.ctx.prNumber,
			});
			return { ok: true, message: "Review already published for this run." };
		}

		const parsed = submitSchema.safeParse(args);
		if (!parsed.success) {
			const message = parsed.error.message;
			params.state.lastValidationError = message;
			log.warn("review_payload_validation_failed", { message });
			throw new Error(`Review payload validation failed: ${message}`);
		}

		params.state.lastValidationError = null;
		await publishReview({
			token: params.token,
			cfg: params.cfg,
			...params.ctx,
			payload: parsed.data,
			publishState: params.state,
		});
		params.state.published = true;
		log.info("review_published", {
			owner: params.ctx.owner,
			repo: params.ctx.repo,
			pr: params.ctx.prNumber,
		});
		return { ok: true };
	};

	return { piTool, executor };
}
