import { describe, expect, it } from "vitest";
import { renderInlineThreadBody, renderReviewSummaryComment } from "../src/agent/reviewRender.js";
import type { ReviewPayload } from "../src/agent/reviewSchema.js";

const ctx = {
	owner: "acme",
	repo: "widgets",
	prNumber: 42,
	headSha: "abc123def456",
	maxFindings: 8,
};

function basePayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
	return {
		prCharacter: "Adds a retry wrapper around the webhook dispatcher.",
		findings: [],
		estimatedEffort: 3,
		relevantTests: "partial",
		securityConcerns: null,
		followUps: [],
		...overrides,
	};
}

describe("renderReviewSummaryComment", () => {
	it("(a) no findings", () => {
		const body = renderReviewSummaryComment(basePayload(), ctx);
		expect(body).toMatchSnapshot();
		expect(body).toContain("## PR Agent Review");
		expect(body).toContain("No P0–P2 findings");
	});

	it("(b) P0 + P3 mix", () => {
		const body = renderReviewSummaryComment(
			basePayload({
				findings: [
					{
						severity: "P0",
						file: "src/index.ts",
						startLine: 10,
						endLine: 12,
						title: "Null deref on empty payload",
						detail: "payload is used before guard",
						fixPrompt: "In src/index.ts lines 10-12, add a null check before dereferencing payload.",
					},
					{
						severity: "P3",
						file: "README.md",
						startLine: 1,
						endLine: 1,
						title: "Typo in heading",
						detail: "minor",
					},
				],
			}),
			ctx,
		);
		expect(body).toMatchSnapshot();
		expect(body).toContain("**P0**");
		expect(body).toContain("[Null deref on empty payload]");
		expect(body).toContain("Typo in heading");
		expect(body).not.toContain("payload is used before guard");
		expect(body).not.toContain("Prompt to fix");
	});

	it("(c) securityConcerns set", () => {
		const body = renderReviewSummaryComment(
			basePayload({ securityConcerns: "Webhook secret compared without timing-safe equal." }),
			ctx,
		);
		expect(body).toMatchSnapshot();
		expect(body).toContain("Webhook secret compared");
	});

	it("escapes pipes in security and follow-ups table cells", () => {
		const body = renderReviewSummaryComment(
			basePayload({
				securityConcerns: "foo | bar",
				followUps: ["baz | qux"],
			}),
			ctx,
		);
		expect(body).toContain("foo \\| bar");
		expect(body).toContain("baz \\| qux");
	});
});

describe("renderInlineThreadBody", () => {
	it("P0 with fixPrompt accordion", () => {
		const body = renderInlineThreadBody({
			severity: "P0",
			file: "src/a.ts",
			startLine: 5,
			endLine: 7,
			title: "Race on shared map",
			detail: "Concurrent writes without lock.",
			fixPrompt: "In src/a.ts lines 5-7, guard the map with a mutex or use Ref.modify.",
		});
		expect(body).toMatchSnapshot();
		expect(body).toContain("<details>");
		expect(body).toContain("Prompt to fix");
	});

	it("P1 with fixPrompt accordion", () => {
		const body = renderInlineThreadBody({
			severity: "P1",
			file: "src/b.ts",
			startLine: 1,
			endLine: 1,
			title: "Missing await",
			detail: "Promise not awaited in handler.",
			fixPrompt: "In src/b.ts line 1, await the promise before returning.",
		});
		expect(body).toMatchSnapshot();
	});

	it("P2 with fixPrompt accordion", () => {
		const body = renderInlineThreadBody({
			severity: "P2",
			file: "src/c.ts",
			startLine: 20,
			endLine: 22,
			title: "Off-by-one in slice",
			detail: "End index excludes last element incorrectly.",
			fixPrompt: "In src/c.ts lines 20-22, adjust slice end index to include the last item.",
		});
		expect(body).toMatchSnapshot();
	});
});
