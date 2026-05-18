import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReview } from "../src/agent/publishReview.js";
import type { ReviewPayload } from "../src/agent/reviewSchema.js";
import { createSubmitReviewState } from "../src/agent/submitReviewTool.js";

vi.mock("../src/github/reviewPublish.js", () => ({
	createPullRequestReviewWithComments: vi.fn(async () => ({ id: 1, url: "https://example.com/review/1" })),
	upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
	listPullRequestLabels: vi.fn(async () => []),
	setPullRequestLabels: vi.fn(async () => undefined),
}));

import {
	createPullRequestReviewWithComments,
	setPullRequestLabels,
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

const baseParams = {
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
};

describe("publishReview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses REQUEST_CHANGES for P1 and passes inline comments", async () => {
		const publishState = createSubmitReviewState();
		await publishReview({ ...baseParams, publishState });

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
		expect(publishState.inlinePublished).toBe(true);
	});

	it("uses COMMENT when only P2 findings", async () => {
		await publishReview({
			...baseParams,
			publishState: createSubmitReviewState(),
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

	it("skips inline review when inlinePublished is already true", async () => {
		const publishState = createSubmitReviewState();
		publishState.inlinePublished = true;

		await publishReview({ ...baseParams, publishState });

		expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
		expect(upsertReviewSummaryComment).toHaveBeenCalled();
	});

	it("does not fail publish when label sync throws", async () => {
		vi.mocked(setPullRequestLabels).mockRejectedValueOnce(new Error("labels forbidden"));

		await expect(
			publishReview({
				...baseParams,
				publishState: createSubmitReviewState(),
				cfg: {
					maxReviewFindings: 8,
					enableReviewLabelsEffort: true,
					enableReviewLabelsSecurity: false,
				},
			}),
		).resolves.toBeUndefined();

		expect(upsertReviewSummaryComment).toHaveBeenCalled();
	});
});
