import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Config } from "../src/config.js";
import { log } from "../src/log.js";

vi.mock("../src/github/reviewPublish.js", () => ({
	createIssueComment: vi.fn(async () => ({ id: 99, url: "https://example.com/issues/comments/99" })),
}));

vi.mock("@earendil-works/pi-ai", () => ({
	getModel: vi.fn(() => ({})),
	complete: vi.fn(async () => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "analysis without submitReview" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	})),
}));

import { createIssueComment } from "../src/github/reviewPublish.js";
import { runFullPrReview } from "../src/agent/reviewRun.js";

const cfg = {
	port: 0,
	githubAppId: "1",
	githubAppPrivateKey: "k",
	webhookSecret: "s",
	piProvider: "openai",
	piModel: "gpt-4o-mini",
	maxToolRounds: 2,
	maxFinalizeRounds: 0,
	maxReviewPublishAttempts: 3,
	reviewConcurrency: 1,
	webhookTimeoutMs: 10_000,
	logLevel: "error",
	maxReviewFindings: 8,
	enableReviewLabelsEffort: false,
	enableReviewLabelsSecurity: false,
} satisfies Config;

describe("runFullPrReview publish retries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("retries submitReview up to maxReviewPublishAttempts before failing", async () => {
		const infoSpy = vi.spyOn(log, "info");

		const result = await runFullPrReview({
			cfg,
			token: "t",
			owner: "o",
			repo: "r",
			prNumber: 1,
			headSha: "sha",
		});

		expect(result.published).toBe(false);
		expect(result.publishAttempts).toBe(3);
		expect(infoSpy).toHaveBeenCalledWith(
			"review_publish_retry",
			expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
		);
		expect(infoSpy).toHaveBeenCalledWith(
			"review_publish_retry",
			expect.objectContaining({ attempt: 3, maxAttempts: 3 }),
		);
	});

	it("posts a maintainer-visible fallback comment when publish is exhausted", async () => {
		const result = await runFullPrReview({
			cfg,
			token: "t",
			owner: "o",
			repo: "r",
			prNumber: 1,
			headSha: "sha",
		});

		expect(result.published).toBe(false);
		expect(createIssueComment).toHaveBeenCalledWith(
			"t",
			"o",
			"r",
			1,
			expect.stringContaining("could not publish structured output"),
		);
		expect(createIssueComment).toHaveBeenCalledWith(
			"t",
			"o",
			"r",
			1,
			expect.stringContaining("analysis without submitReview"),
		);
	});
});
