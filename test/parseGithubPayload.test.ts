import { describe, expect, it } from "vitest";
import { WebhookParseError, parseGithubPayload, parseInstallationId } from "../src/webhook/parseGithubPayload.js";

describe("parseGithubPayload", () => {
	it("returns ignored for unknown events", () => {
		const p = parseGithubPayload("ping", { installation: { id: 1 } });
		expect(p.name).toBe("ignored");
	});

	it("parses pull_request with required fields", () => {
		const raw = {
			action: "opened",
			installation: { id: 42 },
			repository: { owner: { login: "o" }, name: "r" },
			pull_request: { number: 3, head: { sha: "abc" } },
		};
		const p = parseGithubPayload("pull_request", raw);
		expect(p.name).toBe("pull_request");
		expect(p.data.installation.id).toBe(42);
		expect(p.data.pull_request.head.sha).toBe("abc");
	});

	it("throws WebhookParseError on malformed pull_request", () => {
		expect(() => parseGithubPayload("pull_request", { action: "opened" })).toThrow(WebhookParseError);
	});
});

describe("parseInstallationId", () => {
	it("extracts installation id when present", () => {
		expect(parseInstallationId({ installation: { id: 7 } })).toBe(7);
	});

	it("returns undefined when missing", () => {
		expect(parseInstallationId({})).toBeUndefined();
	});
});
