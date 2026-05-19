import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { Config } from "../src/config.js";
import { WebhookParseError } from "../src/webhook/parseGithubPayload.js";
import { dispatchGithubEventEffect } from "../src/effect/programs/dispatchEffect.js";
import { WebhookHandlers } from "../src/effect/services/webhookHandlers.js";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import * as parseModule from "../src/webhook/parseGithubPayload.js";

const cfg: Config = {
	port: 3000,
	githubAppId: "1",
	githubAppPrivateKey: "k",
	webhookSecret: "s",
	databaseUrl: "postgres://test",
	role: "web",
	piProvider: "openai",
	piModel: "gpt-4o-mini",
	maxToolRounds: 24,
	maxFinalizeRounds: 6,
	maxReviewPublishAttempts: 3,
	reviewConcurrency: 2,
	askConcurrency: 1,
	ackConcurrency: 2,
	queueRetryLimit: 3,
	queueRetryDelaySeconds: 30,
	queueRetryDelayMaxSeconds: 300,
	queueExpireInSeconds: 3600,
	queueHeartbeatSeconds: 60,
	queueRetentionSeconds: 1209600,
	queueDeleteAfterSeconds: 604800,
	installationGroupConcurrency: 2,
	maxAskToolRounds: 12,
	webhookTimeoutMs: 10000,
	context7ApiKey: "",
	maxReviewFindings: 8,
	enableReviewLabelsEffort: false,
	enableReviewLabelsSecurity: false,
	maxPrFilesListed: 300,
	maxPrFilesPatchBytes: 500000,
	logLevel: "error",
};

type Trace = {
	recordIgnored: ReturnType<typeof vi.fn>;
	submitAutomatedReview: ReturnType<typeof vi.fn>;
	submitSlashCommand: ReturnType<typeof vi.fn>;
	pullRequest: ReturnType<typeof vi.fn>;
	issueComment: ReturnType<typeof vi.fn>;
	pullRequestReviewComment: ReturnType<typeof vi.fn>;
};

function buildLayers(trace: Trace) {
	const schedulerLayer = Layer.succeed(
		AgentWorkScheduler,
		AgentWorkScheduler.of({
			recordIgnored: (headers, decision) =>
				Effect.sync(() => {
					trace.recordIgnored(headers, decision);
				}),
			submitAutomatedReview: (headers, ref, action) =>
				Effect.sync(() => {
					trace.submitAutomatedReview(headers, ref, action);
				}),
			submitSlashCommand: (input) =>
				Effect.sync(() => {
					trace.submitSlashCommand(input);
				}),
		}),
	);

	const handlersLayer = Layer.succeed(
		WebhookHandlers,
		WebhookHandlers.of({
			pullRequest: (cfg, headers, data) =>
				Effect.sync(() => {
					trace.pullRequest(cfg, headers, data);
				}),
			issueComment: (cfg, headers, data) =>
				Effect.sync(() => {
					trace.issueComment(cfg, headers, data);
				}),
			pullRequestReviewComment: (cfg, headers, data) =>
				Effect.sync(() => {
					trace.pullRequestReviewComment(cfg, headers, data);
				}),
		}),
	);

	return Layer.mergeAll(schedulerLayer, handlersLayer);
}

function newTrace(): Trace {
	return {
		recordIgnored: vi.fn(),
		submitAutomatedReview: vi.fn(),
		submitSlashCommand: vi.fn(),
		pullRequest: vi.fn(),
		issueComment: vi.fn(),
		pullRequestReviewComment: vi.fn(),
	};
}

describe("dispatchGithubEventEffect ordering", () => {
	it("stops on parse error without durable intake", async () => {
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

			expect(trace.recordIgnored).not.toHaveBeenCalled();
			expect(trace.pullRequest).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("records ignored events without minting tokens", async () => {
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

			expect(trace.recordIgnored).toHaveBeenCalledWith(
				{ event: "ping", delivery: "d2", rawBody: expect.any(Buffer) },
				"ignored_event_ping",
			);
			expect(trace.pullRequest).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("routes pull_request to handler with raw headers and no token", async () => {
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

			expect(trace.pullRequest).toHaveBeenCalledWith(
				cfg,
				{ event: "pull_request", delivery: "d3", rawBody: expect.any(Buffer) },
				parsedData,
			);
			expect(trace.submitAutomatedReview).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
