import { describe, expect, it } from "vitest";
import { reviewEventForFindings, selectInlineFindings } from "../src/agent/reviewSchema.js";
import type { ReviewFinding } from "../src/agent/reviewSchema.js";

describe("reviewEventForFindings", () => {
	it("REQUEST_CHANGES when P0 present", () => {
		expect(
			reviewEventForFindings([
				{
					severity: "P0",
					file: "a.ts",
					startLine: 1,
					endLine: 1,
					title: "t",
					detail: "d",
					fixPrompt: "fix",
				},
			]),
		).toBe("REQUEST_CHANGES");
	});

	it("REQUEST_CHANGES when P1 present", () => {
		expect(
			reviewEventForFindings([
				{
					severity: "P1",
					file: "a.ts",
					startLine: 1,
					endLine: 1,
					title: "t",
					detail: "d",
					fixPrompt: "fix",
				},
			]),
		).toBe("REQUEST_CHANGES");
	});

	it("COMMENT when only P2/P3", () => {
		expect(
			reviewEventForFindings([
				{
					severity: "P2",
					file: "a.ts",
					startLine: 1,
					endLine: 1,
					title: "t",
					detail: "d",
					fixPrompt: "fix",
				},
			]),
		).toBe("COMMENT");
	});
});

describe("selectInlineFindings", () => {
	const f = (severity: ReviewFinding["severity"], title: string): ReviewFinding => ({
		severity,
		file: "x.ts",
		startLine: 1,
		endLine: 1,
		title,
		detail: "d",
		fixPrompt: severity === "P3" ? undefined : "fix",
	});

	it("truncates by severity order", () => {
		const selected = selectInlineFindings([f("P2", "p2"), f("P0", "p0"), f("P1", "p1")], 2);
		expect(selected.map((x) => x.title)).toEqual(["p0", "p1"]);
	});

	it("excludes P3", () => {
		const selected = selectInlineFindings([f("P3", "p3"), f("P1", "p1")], 8);
		expect(selected.map((x) => x.title)).toEqual(["p1"]);
	});
});
