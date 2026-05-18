import { describe, expect, it, vi, beforeEach } from "vitest";
import { REVIEW_SUMMARY_SENTINEL } from "../src/agent/reviewSchema.js";

const listComments = vi.fn();

vi.mock("../src/github/appAuth.js", () => ({
	installationOctokit: () => ({
		rest: {
			issues: {
				listComments,
			},
		},
	}),
}));

import { findIssueCommentBySentinel } from "../src/github/reviewPublish.js";

describe("findIssueCommentBySentinel", () => {
	beforeEach(() => {
		listComments.mockReset();
	});

	it("paginates and returns the last matching comment across pages", async () => {
		const filler = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			body: `comment ${i}`,
		}));
		listComments
			.mockResolvedValueOnce({ data: filler })
			.mockResolvedValueOnce({
				data: [
					{ id: 101, body: `${REVIEW_SUMMARY_SENTINEL}\n\nold` },
					{ id: 102, body: `${REVIEW_SUMMARY_SENTINEL}\n\nnewest` },
				],
			});

		const hit = await findIssueCommentBySentinel("tok", "o", "r", 42, REVIEW_SUMMARY_SENTINEL);

		expect(listComments).toHaveBeenCalledTimes(2);
		expect(hit).toEqual({ id: 102 });
	});

	it("returns null when no comment matches", async () => {
		listComments.mockResolvedValueOnce({ data: [{ id: 1, body: "hello" }] });

		const hit = await findIssueCommentBySentinel("tok", "o", "r", 1, REVIEW_SUMMARY_SENTINEL);

		expect(hit).toBeNull();
	});
});
