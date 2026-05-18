import { RequestError } from "@octokit/request-error";
import { describe, expect, it } from "vitest";
import {
	classifyGithubToolError,
	extractGithubResponseMeta,
	formatToolErrorMessage,
	isRateLimitClassification,
} from "../src/github/githubRequestError.js";

function httpError(
	status: number,
	message: string,
	headers: Record<string, string> = {},
): RequestError {
	return new RequestError(message, status, {
		request: { method: "GET", url: "https://api.github.com/test", headers: {} },
		response: {
			status,
			url: "https://api.github.com/test",
			headers,
			data: { message },
		},
	});
}

describe("githubRequestError", () => {
	const youngExpiry = Date.now() + 30 * 60 * 1000;

	it("classifies probable_secondary for Bad credentials on young token without primary headers", () => {
		const err = httpError(401, "Bad credentials - https://docs.github.com/rest");
		const c = classifyGithubToolError(err, { expiresAtTs: youngExpiry });
		expect(c.classification).toBe("probable_secondary");
		expect(isRateLimitClassification(c.classification)).toBe(true);
	});

	it("classifies rate_limit when x-ratelimit-remaining is 0 even with Bad credentials message", () => {
		const err = httpError(401, "Bad credentials - https://docs.github.com/rest", {
			"x-ratelimit-remaining": "0",
		});
		const c = classifyGithubToolError(err, { expiresAtTs: youngExpiry });
		expect(c.classification).toBe("rate_limit");
	});

	it("classifies Bad credentials as auth when token is near expiry (HttpError)", () => {
		const err = httpError(401, "Bad credentials - https://docs.github.com/rest");
		const c = classifyGithubToolError(err, { expiresAtTs: Date.now() + 30_000 });
		expect(c.classification).toBe("auth");
	});

	it("classifies rate_limit on near-expiry token when x-ratelimit-remaining is 0", () => {
		const err = httpError(403, "API rate limit exceeded", {
			"x-ratelimit-remaining": "0",
		});
		const c = classifyGithubToolError(err, { expiresAtTs: Date.now() + 30_000 });
		expect(c.classification).toBe("rate_limit");
	});

	it("classifies plain errors as token_expired when token is near expiry", () => {
		const c = classifyGithubToolError(new Error("Installation token near expiry"), {
			expiresAtTs: Date.now() + 30_000,
		});
		expect(c.classification).toBe("token_expired");
	});

	it("classifies secondary_rate_limit from message", () => {
		const err = httpError(
			403,
			"You have exceeded a secondary rate limit. Please wait.",
			{ "retry-after": "120" },
		);
		const c = classifyGithubToolError(err, { expiresAtTs: youngExpiry });
		expect(c.classification).toBe("secondary_rate_limit");
		expect(c.retryAfterSource).toBe("header");
		expect(c.retryAfterSeconds).toBe(120);
	});

	it("classifies rate_limit when x-ratelimit-remaining is 0", () => {
		const reset = String(Math.floor(Date.now() / 1000) + 120);
		const err = httpError(403, "API rate limit exceeded", {
			"x-ratelimit-remaining": "0",
			"x-ratelimit-reset": reset,
		});
		const c = classifyGithubToolError(err, { expiresAtTs: youngExpiry });
		expect(c.classification).toBe("rate_limit");
	});

	it("extractGithubResponseMeta maps lowercase headers", () => {
		const err = httpError(429, "Too Many Requests", {
			"x-github-request-id": "ABC:123",
			"x-ratelimit-resource": "core",
			"retry-after": "5",
		});
		const meta = extractGithubResponseMeta(err);
		expect(meta.githubRequestId).toBe("ABC:123");
		expect(meta.rateLimitResource).toBe("core");
		expect(meta.retryAfterHeader).toBe("5");
	});

	it("formatToolErrorMessage includes cooldown for rate limit classes", () => {
		const err = httpError(403, "secondary rate", { "retry-after": "10" });
		const c = classifyGithubToolError(err, { expiresAtTs: youngExpiry });
		const text = formatToolErrorMessage("getFileContent", err, c);
		expect(text).toMatch(/Rate-limit cooldown 10s/);
		expect(text).toMatch(/do not issue tool calls/);
	});
});
