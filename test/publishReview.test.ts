import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReview } from "../src/agent/publishReview.js";
import type { ReviewPayload } from "../src/agent/reviewSchema.js";

vi.mock("../src/github/reviewPublish.js", () => ({
	createPullRequestReviewWithComments: vi.fn(async () => ({ id: 1, url: "https://example.com/review/1" })),
	upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
	listPullRequestLabels: vi.fn(async () => []),
	setPullRequestLabels: vi.fn(async () => undefined),
}));

import {
	createPullRequestReviewWithComments,
	upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

const payload: ReviewPayload = {
	prCharacter: "Test PR.",
	findings: [
		{
			severity: "P1",
			file: "src/x.ts",
			startLine: 4,
			endLine: 4,
			title: "Bug",
			detail: "Bad logic.",
			fixPrompt: "Fix src/x.ts line 4.",
		},
	],
	estimatedEffort: 2,
	relevantTests: "no",
	securityConcerns: null,
	followUps: [],
};

describe("publishReview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses REQUEST_CHANGES for P1 and passes inline comments", async () => {
		await publishReview({
			token: "t",
			owner: "o",
			repo: "r",
			prNumber: 1,
			headSha: "sha",
			cfg: {
				maxReviewFindings: 8,
				enableReviewLabelsEffort: false,
				enableReviewLabelsSecurity: false,
			},
			payload,
		});

		expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
			"t",
			"o",
			"r",
			1,
			expect.objectContaining({
				event: "REQUEST_CHANGES",
				comments: [
					expect.objectContaining({
						path: "src/x.ts",
						line: 4,
						side: "RIGHT",
					}),
				],
			}),
		);
		expect(upsertReviewSummaryComment).toHaveBeenCalled();
	});

	it("uses COMMENT when only P2 findings", async () => {
		await publishReview({
			token: "t",
			owner: "o",
			repo: "r",
			prNumber: 1,
			headSha: "sha",
			cfg: {
				maxReviewFindings: 8,
				enableReviewLabelsEffort: false,
				enableReviewLabelsSecurity: false,
			},
			payload: {
				...payload,
				findings: [{ ...payload.findings[0]!, severity: "P2" }],
			},
		});

		expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
			"t",
			"o",
			"r",
			1,
			expect.objectContaining({ event: "COMMENT" }),
		);
	});
});
