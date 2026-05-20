import { describe, expect, it } from "vitest";
import {
	coerceReviewPayloadInput,
	formatReviewValidationError,
	reviewEventForFindings,
	reviewPayloadSchema,
	selectInlineFindings,
} from "../src/agent/reviewSchema.js";
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

describe("coerceReviewPayloadInput", () => {
	it("maps CRITICAL severity alias to P0", () => {
		const { value, coerced } = coerceReviewPayloadInput({
			prCharacter: "x",
			findings: [
				{
					severity: "CRITICAL",
					file: "a.ts",
					startLine: "10",
					endLine: "10",
					title: "t",
					detail: "d",
					fixPrompt: "fix",
				},
			],
			estimatedEffort: "3",
			relevantTests: "no",
			securityConcerns: null,
			followUps: [],
		});
		expect(coerced).toBe(true);
		const parsed = reviewPayloadSchema.safeParse(value);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.findings[0]?.severity).toBe("P0");
			expect(parsed.data.findings[0]?.startLine).toBe(10);
			expect(parsed.data.estimatedEffort).toBe(3);
		}
	});

	it("preserves finding reference when no finding field changes", () => {
		const finding = {
			severity: "P1",
			file: "a.ts",
			startLine: 10,
			endLine: 10,
			title: "t",
			detail: "d",
			fixPrompt: "fix",
		};
		const { value } = coerceReviewPayloadInput({
			prCharacter: "x",
			findings: [finding],
			estimatedEffort: 2,
			relevantTests: "no",
			securityConcerns: null,
			followUps: [],
		});
		const out = value as { findings: unknown[] };
		expect(out.findings[0]).toBe(finding);
	});

	it("trims securityConcerns only when whitespace changes the value", () => {
		const trimmed = coerceReviewPayloadInput({
			prCharacter: "x",
			findings: [],
			estimatedEffort: 1,
			relevantTests: "no",
			securityConcerns: "  timing issue  ",
			followUps: [],
		});
		expect((trimmed.value as { securityConcerns: string }).securityConcerns).toBe("timing issue");
		expect(trimmed.coerced).toBe(true);

		const alreadyTrimmed = coerceReviewPayloadInput({
			prCharacter: "x",
			findings: [],
			estimatedEffort: 1,
			relevantTests: "no",
			securityConcerns: "plain",
			followUps: [],
		});
		expect((alreadyTrimmed.value as { securityConcerns: string }).securityConcerns).toBe("plain");
	});
});

describe("formatReviewValidationError", () => {
	it("lists field paths in bullet form", () => {
		const parsed = reviewPayloadSchema.safeParse({ prCharacter: "x" });
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			const msg = formatReviewValidationError(parsed.error);
			expect(msg).toContain("ReviewPayload validation failed:");
			expect(msg).toContain("findings");
		}
	});
});
