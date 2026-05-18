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

import { complete } from "@earendil-works/pi-ai";
import { createIssueComment } from "../src/github/reviewPublish.js";
import { automatedSecuritySystemPrompt } from "../src/agent/securityPrompt.js";
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
	maxPrFilesListed: 300,
	maxPrFilesPatchBytes: 500_000,
} satisfies Config;

const farFutureTokenExpiry = Date.now() + 3_600_000;

function reviewParams(
	overrides: Partial<Parameters<typeof runFullPrReview>[0]> = {},
): Parameters<typeof runFullPrReview>[0] {
	return {
		cfg,
		token: "t",
		tokenExpiresAtTs: farFutureTokenExpiry,
		owner: "o",
		repo: "r",
		prNumber: 1,
		headSha: "sha",
		...overrides,
	};
}

const defaultCompleteResult = () => ({
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
});

describe("runFullPrReview mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(complete).mockImplementation(async () => defaultCompleteResult());
	});

	it("requires finite tokenExpiresAtTs", async () => {
		await expect(runFullPrReview(reviewParams({ tokenExpiresAtTs: NaN }))).rejects.toThrow(
			/tokenExpiresAtTs/,
		);
	});

	it("selects security system prompt when mode is review-security", async () => {
		await runFullPrReview(
			reviewParams({
				cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 },
				mode: "review-security",
			}),
		);

		const context = vi.mocked(complete).mock.calls[0]![1] as { systemPrompt: string };
		expect(context.systemPrompt).toBe(automatedSecuritySystemPrompt);
	});

	it("selects general system prompt by default", async () => {
		await runFullPrReview(
			reviewParams({ cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 } }),
		);

		const context = vi.mocked(complete).mock.calls[0]![1] as { systemPrompt: string };
		expect(context.systemPrompt).toContain("senior staff software engineer");
		expect(context.systemPrompt).not.toBe(automatedSecuritySystemPrompt);
	});

	it("requires tools on round 0 for both modes when tools are available", async () => {
		for (const mode of ["review", "review-security"] as const) {
			vi.mocked(complete).mockClear();
			await runFullPrReview(
				reviewParams({ cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 }, mode }),
			);
			expect(vi.mocked(complete).mock.calls[0]![2]).toEqual({ toolChoice: "required" });
		}
	});

	it("includes mode on agent_tool_round when tools run", async () => {
		vi.mocked(complete).mockImplementationOnce(async () => ({
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "c1",
					name: "getPullRequest",
					arguments: { owner: "o", repo: "r", pullNumber: 1 },
				},
			],
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
			stopReason: "toolUse" as const,
			timestamp: Date.now(),
		}));
		vi.mocked(complete).mockImplementation(async () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done" }],
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
		}));

		const infoSpy = vi.spyOn(log, "info");
		await runFullPrReview(
			reviewParams({
				cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 },
				mode: "review-security",
			}),
		);

		expect(infoSpy).toHaveBeenCalledWith(
			"agent_tool_round",
			expect.objectContaining({ mode: "review-security" }),
		);
	});

	it("uses security fallback heading when security publish is exhausted", async () => {
		await runFullPrReview(reviewParams({ mode: "review-security" }));

		expect(createIssueComment).toHaveBeenCalledWith(
			"t",
			"o",
			"r",
			1,
			expect.stringContaining("## PR Agent Security Review — could not publish"),
		);
	});
});

describe("runFullPrReview publish retries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(complete).mockImplementation(async () => defaultCompleteResult());
	});

	it("retries submitReview up to maxReviewPublishAttempts before failing", async () => {
		const infoSpy = vi.spyOn(log, "info");

		const result = await runFullPrReview(reviewParams());

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
		const result = await runFullPrReview(reviewParams());

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
