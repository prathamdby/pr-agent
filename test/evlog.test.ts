import { describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";

describe("runWithOperationLogger", () => {
	it("propagates fn error when emit throws", async () => {
		const realCreate = evlog.createOperationLogger;
		vi.spyOn(evlog, "createOperationLogger").mockImplementation((meta) => {
			const logger = realCreate(meta);
			vi.spyOn(logger, "emit").mockRejectedValue(new Error("emit failed"));
			return logger;
		});

		try {
			await expect(
				evlog.runWithOperationLogger({ method: "GET", path: "/test" }, async () => {
					throw new Error("original");
				}),
			).rejects.toThrow("original");
		} finally {
			vi.restoreAllMocks();
		}
	});
});
