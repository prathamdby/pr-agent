import { describe, expect, it } from "vitest";
import { ASK_USAGE_HINT, parseAskQuestion } from "../src/commands/parseAskQuestion.js";

describe("parseAskQuestion", () => {
	it("extracts unquoted question from first line", () => {
		expect(parseAskQuestion("/ask what is this for?")).toBe("what is this for?");
	});

	it("extracts double-quoted question", () => {
		expect(parseAskQuestion('/ask "what is useHydrationSafeDistance?"')).toBe(
			"what is useHydrationSafeDistance?",
		);
	});

	it("extracts single-quoted question", () => {
		expect(parseAskQuestion("/ask 'why this change?'")).toBe("why this change?");
	});

	it("returns null for bare /ask", () => {
		expect(parseAskQuestion("/ask")).toBe(null);
		expect(parseAskQuestion("/ask   ")).toBe(null);
	});

	it("returns null when not an ask command", () => {
		expect(parseAskQuestion("/review")).toBe(null);
		expect(parseAskQuestion("hello")).toBe(null);
	});

	it("uses first non-empty line only", () => {
		expect(parseAskQuestion(" \n/ask what is this?")).toBe("what is this?");
	});

	it("is case-sensitive on /ask token", () => {
		expect(parseAskQuestion("/Ask what?")).toBe(null);
	});

	it("exports usage hint", () => {
		expect(ASK_USAGE_HINT).toContain("/ask");
	});
});
