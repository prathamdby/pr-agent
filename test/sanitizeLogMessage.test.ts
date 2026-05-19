import { describe, expect, it } from "vitest";
import { sanitizeLogMessage } from "../src/security/sanitizeLogMessage.js";

describe("sanitizeLogMessage", () => {
	it("strips null bytes", () => {
		expect(sanitizeLogMessage("fail\0here")).toBe("failhere");
	});

	it("redacts bearer tokens", () => {
		expect(sanitizeLogMessage("auth failed Bearer ghp_abc123")).toBe("auth failed Bearer [redacted]");
	});

	it("redacts labeled secrets", () => {
		expect(sanitizeLogMessage("token=supersecret password: x api_key=123")).toBe(
			"token=[redacted] password=[redacted] api_key=[redacted]",
		);
	});

	it("redacts Authorization headers", () => {
		expect(sanitizeLogMessage("Authorization: Bearer xyz")).toBe("Authorization: [redacted] [redacted]");
	});

	it("truncates to 2000 characters", () => {
		const long = "x".repeat(2500);
		expect(sanitizeLogMessage(long)).toHaveLength(2000);
	});
});
