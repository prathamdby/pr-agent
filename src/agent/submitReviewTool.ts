import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { publishReview } from "./publishReview.js";
import {
	reviewPayloadSchema,
	SECURITY_REVIEW_SUMMARY_SENTINEL,
	REVIEW_SUMMARY_SENTINEL,
	type ReviewMode,
	type ReviewPublishContext,
} from "./reviewSchema.js";

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
	inlinePublished: boolean;
	lastValidationError: string | null;
};

export function buildSubmitReviewTool(params: {
	cfg: Config;
	token: string;
	ctx: ReviewPublishContext;
	mode?: ReviewMode;
	state: SubmitReviewState;
	recordPublishStep?: (
		step: "inline_review" | "summary_comment" | "labels",
		detail?: { githubId?: string | number; meta?: Record<string, unknown> },
	) => Promise<void>;
	shouldAbortPublish?: () => Promise<boolean>;
}): {
	piTool: PiTool;
	executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
	const submitSchema = reviewPayloadSchema;
	const mode = params.mode ?? "review";

	const summarySentinel =
		mode === "review-security" ? SECURITY_REVIEW_SUMMARY_SENTINEL : REVIEW_SUMMARY_SENTINEL;
	const piTool: PiTool = {
		name: "submitReview",
		description: [
			"Submit the completed structured review exactly once.",
			"Pass a ReviewPayload object matching the schema.",
			`This publishes inline review threads and a PR conversation summary starting with \`${summarySentinel}\`.`,
			"Do not call createPullRequestReview or addPullRequestComment.",
		].join(" "),
		parameters: z.toJSONSchema(submitSchema, { unrepresentable: "any" }) as PiTool["parameters"],
	};

	const executor = async (args: Record<string, unknown>) => {
		if (params.state.published) {
			log.info("review_submit_duplicate_ignored", {
				mode,
				owner: params.ctx.owner,
				repo: params.ctx.repo,
				pr: params.ctx.prNumber,
			});
			return { ok: true };
		}

		const parsed = submitSchema.safeParse(args);
		if (!parsed.success) {
			const message = parsed.error.message;
			params.state.lastValidationError = message;
			log.warn("review_payload_validation_failed", { mode, message });
			throw new Error(`Review payload validation failed: ${message}`);
		}

		params.state.lastValidationError = null;
		if (params.shouldAbortPublish && (await params.shouldAbortPublish())) {
			log.info("review_submit_skipped_superseded", {
				mode,
				owner: params.ctx.owner,
				repo: params.ctx.repo,
				pr: params.ctx.prNumber,
			});
			throw new Error("Review publish skipped: work superseded or cancelled");
		}
		await publishReview({
			token: params.token,
			mode,
			cfg: params.cfg,
			...params.ctx,
			payload: parsed.data,
			publishState: params.state,
			recordPublishStep: params.recordPublishStep,
		});
		params.state.published = true;
		log.info("review_published", {
			mode,
			owner: params.ctx.owner,
			repo: params.ctx.repo,
			pr: params.ctx.prNumber,
		});
		return { ok: true };
	};

	return { piTool, executor };
}
