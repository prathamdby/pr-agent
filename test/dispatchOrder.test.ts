import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initLog } from "../src/log.js";

vi.mock("../src/github/appAuth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/github/appAuth.js")>();
	return {
		...actual,
		getInstallationToken: vi.fn(),
	};
});

import { getInstallationToken } from "../src/github/appAuth.js";
import { dispatchGithubEvent } from "../src/webhook/dispatch.js";

const baseCfg = {
	port: 3000,
	githubAppId: "1",
	githubAppPrivateKey: "k",
	webhookSecret: "s",
	piProvider: "openai" as const,
	piModel: "gpt-4o-mini",
	maxToolRounds: 24,
	maxFinalizeRounds: 6,
	logLevel: "info" as const,
};

describe("dispatch ordering", () => {
	beforeAll(() => {
		initLog("error");
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
	});

	it("does not call getInstallationToken when Zod rejects pull_request payload (parse before dedupe)", async () => {
		const rawBody = Buffer.from("{}");
		const invalid = {
			installation: { id: 1 },
			repository: { owner: { login: "o" }, name: "n" },
			action: "opened",
		} as Record<string, unknown>;

		await dispatchGithubEvent(baseCfg, { event: "pull_request", delivery: "ord-1", rawBody }, invalid);
		expect(getInstallationToken).not.toHaveBeenCalled();
	});

	it("calls getInstallationToken for ignored event when installation present", async () => {
		const payload = { installation: { id: 99 }, zen: "x" };
		const rawBody = Buffer.from(JSON.stringify(payload));
		await dispatchGithubEvent(baseCfg, { event: "ping", delivery: "ord-2", rawBody }, payload);
		expect(getInstallationToken).toHaveBeenCalledWith(baseCfg, 99);
	});
});
