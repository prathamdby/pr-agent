import { describe, expect, it } from "vitest";
import { syncReviewLabels } from "../src/agent/reviewLabels.js";

describe("syncReviewLabels", () => {
	it("replaces Review effort label and preserves unrelated labels", () => {
		const current = ["Review effort 3/5", "bug", "enhancement"];
		const next = syncReviewLabels(current, ["Review effort 4/5"]);
		expect(next).toEqual(["bug", "enhancement", "Review effort 4/5"]);
	});

	it("drops Possible security concern when not in next managed set", () => {
		const current = ["Possible security concern", "docs"];
		const next = syncReviewLabels(current, ["Review effort 2/5"]);
		expect(next).toEqual(["docs", "Review effort 2/5"]);
	});
});
