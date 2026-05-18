import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { Config } from "../src/config.js";
import { WebhookParseError } from "../src/webhook/parseGithubPayload.js";
import { dispatchGithubEventEffect } from "../src/effect/programs/dispatchEffect.js";
import { DeliveryDedupe } from "../src/effect/services/deliveryDedupe.js";
import type { InstallationToken } from "../src/github/appAuth.js";
import { GithubInstallationToken } from "../src/effect/services/githubInstallationToken.js";
import { WebhookHandlers } from "../src/effect/services/webhookHandlers.js";
import * as parseModule from "../src/webhook/parseGithubPayload.js";

const cfg: Config = {
	port: 3000,
	githubAppId: "1",
	githubAppPrivateKey: "k",
	webhookSecret: "s",
	piProvider: "openai",
	piModel: "gpt-4o-mini",
	maxToolRounds: 24,
	maxFinalizeRounds: 6,
	maxReviewPublishAttempts: 3,
	reviewConcurrency: 2,
	webhookTimeoutMs: 10000,
	logLevel: "error",
};

const fakeInstallationToken: InstallationToken = {
	token: "fake-token",
	expiresAtTs: Date.now() + 3_600_000,
	ttlMs: 3_600_000,
};

type Trace = {
	dedupeKey: ReturnType<typeof vi.fn>;
	seenOrMark: ReturnType<typeof vi.fn>;
	getToken: ReturnType<typeof vi.fn>;
	pullRequest: ReturnType<typeof vi.fn>;
	issueComment: ReturnType<typeof vi.fn>;
	pullRequestReviewComment: ReturnType<typeof vi.fn>;
};

function buildLayers(trace: Trace) {
	const dedupeLayer = Layer.succeed(
		DeliveryDedupe,
		DeliveryDedupe.of({
			key: (delivery, body) =>
				Effect.sync(() => {
					trace.dedupeKey(delivery, body);
					return delivery ?? "body:hash";
				}),
			seenOrMark: (key) =>
				Effect.sync(() => {
					trace.seenOrMark(key);
					return false;
				}),
		}),
	);

	const tokenLayer = Layer.succeed(
		GithubInstallationToken,
		GithubInstallationToken.of({
			getToken: (cfg, installationId) =>
				Effect.sync(() => {
					trace.getToken(cfg, installationId);
					return fakeInstallationToken;
				}),
		}),
	);

	const handlersLayer = Layer.succeed(
		WebhookHandlers,
		WebhookHandlers.of({
			pullRequest: (cfg, token, data) =>
				Effect.sync(() => {
					trace.pullRequest(cfg, token, data);
				}),
			issueComment: (cfg, token, data) =>
				Effect.sync(() => {
					trace.issueComment(cfg, token, data);
				}),
			pullRequestReviewComment: (cfg, token, data) =>
				Effect.sync(() => {
					trace.pullRequestReviewComment(cfg, token, data);
				}),
		}),
	);

	return Layer.mergeAll(dedupeLayer, tokenLayer, handlersLayer);
}

function newTrace(): Trace {
	return {
		dedupeKey: vi.fn(),
		seenOrMark: vi.fn(),
		getToken: vi.fn(),
		pullRequest: vi.fn(),
		issueComment: vi.fn(),
		pullRequestReviewComment: vi.fn(),
	};
}

describe("dispatchGithubEventEffect ordering", () => {
	it("stops on parse error without dedupe/token", async () => {
		const trace = newTrace();
		const spy = vi.spyOn(parseModule, "parseGithubPayload").mockImplementation(() => {
			throw new WebhookParseError("bad", "pull_request");
		});

		try {
			await Effect.runPromise(
				dispatchGithubEventEffect({
					cfg,
					headers: { event: "pull_request", delivery: "d0", rawBody: Buffer.from("{}") },
					payload: {},
				}).pipe(Effect.provide(buildLayers(trace))),
			);

			expect(trace.seenOrMark).not.toHaveBeenCalled();
			expect(trace.getToken).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("stops on duplicate before token", async () => {
		const trace = newTrace();
		const spy = vi
			.spyOn(parseModule, "parseGithubPayload")
			.mockReturnValue({ name: "ignored", data: {} });

		// Override seenOrMark to return duplicate
		const duplicateDedupeLayer = Layer.succeed(
			DeliveryDedupe,
			DeliveryDedupe.of({
				key: (delivery) => Effect.sync(() => delivery ?? "body:hash"),
				seenOrMark: () => Effect.sync(() => true),
			}),
		);

		try {
			await Effect.runPromise(
				dispatchGithubEventEffect({
					cfg,
					headers: { event: "ping", delivery: "d1", rawBody: Buffer.from("{}") },
					payload: {},
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							duplicateDedupeLayer,
							Layer.succeed(
								GithubInstallationToken,
								GithubInstallationToken.of({
									getToken: (cfg, id) =>
										Effect.sync(() => {
											trace.getToken(cfg, id);
											return fakeInstallationToken;
										}),
								}),
							),
							Layer.succeed(
								WebhookHandlers,
								WebhookHandlers.of({
									pullRequest: () => Effect.void,
									issueComment: () => Effect.void,
									pullRequestReviewComment: () => Effect.void,
								}),
							),
						),
					),
				),
			);

			expect(trace.getToken).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("skips token for ignored event", async () => {
		const trace = newTrace();
		const spy = vi
			.spyOn(parseModule, "parseGithubPayload")
			.mockReturnValue({ name: "ignored", data: {} });

		try {
			await Effect.runPromise(
				dispatchGithubEventEffect({
					cfg,
					headers: { event: "ping", delivery: "d2", rawBody: Buffer.from("{}") },
					payload: {},
				}).pipe(Effect.provide(buildLayers(trace))),
			);

			expect(trace.getToken).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("routes pull_request to handler with minted token", async () => {
		const trace = newTrace();
		const parsedData = {
			action: "opened",
			installation: { id: 7 },
			repository: { owner: { login: "o" }, name: "r" },
			pull_request: { number: 1, head: { sha: "abc" } },
		};
		const spy = vi
			.spyOn(parseModule, "parseGithubPayload")
			.mockReturnValue({ name: "pull_request", data: parsedData as never });

		try {
			await Effect.runPromise(
				dispatchGithubEventEffect({
					cfg,
					headers: { event: "pull_request", delivery: "d3", rawBody: Buffer.from("{}") },
					payload: {},
				}).pipe(Effect.provide(buildLayers(trace))),
			);

			expect(trace.getToken).toHaveBeenCalledWith(cfg, 7);
			expect(trace.pullRequest).toHaveBeenCalledWith(cfg, fakeInstallationToken, parsedData);
		} finally {
			spy.mockRestore();
		}
	});
});
