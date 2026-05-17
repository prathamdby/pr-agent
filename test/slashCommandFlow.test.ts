import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { Config } from "../src/config.js";
import { PrGithubSurface } from "../src/effect/services/prGithubSurface.js";
import { ReviewQueue } from "../src/effect/services/reviewQueue.js";
import { runSlashCommandFlow, type SlashContext } from "../src/commands/slashCommandFlow.js";
import * as reviewRun from "../src/agent/reviewRun.js";

const cfg: Config = {
	port: 0,
	githubAppId: "1",
	githubAppPrivateKey: "k",
	webhookSecret: "s",
	piProvider: "openai",
	piModel: "gpt-4o-mini",
	maxToolRounds: 24,
	maxFinalizeRounds: 6,
	reviewConcurrency: 2,
	webhookTimeoutMs: 10000,
	logLevel: "error",
};

type SurfaceSpies = {
	acknowledgeOnPrConversation: ReturnType<typeof vi.fn>;
	acknowledgeOnIssueComment: ReturnType<typeof vi.fn>;
	acknowledgeOnReviewComment: ReturnType<typeof vi.fn>;
	postPrConversationComment: ReturnType<typeof vi.fn>;
	replyOnInlineReviewThread: ReturnType<typeof vi.fn>;
	getPullRequestHeadSha: ReturnType<typeof vi.fn>;
};

function makeSurface(spies: SurfaceSpies, headSha = "abc"): Layer.Layer<PrGithubSurface> {
	return Layer.succeed(
		PrGithubSurface,
		PrGithubSurface.of({
			acknowledgeOnPrConversation: (...args) => {
				spies.acknowledgeOnPrConversation(...args);
				return Effect.void;
			},
			acknowledgeOnIssueComment: (...args) => {
				spies.acknowledgeOnIssueComment(...args);
				return Effect.void;
			},
			acknowledgeOnReviewComment: (...args) => {
				spies.acknowledgeOnReviewComment(...args);
				return Effect.void;
			},
			postPrConversationComment: (...args) => {
				spies.postPrConversationComment(...args);
				return Effect.void;
			},
			replyOnInlineReviewThread: (...args) => {
				spies.replyOnInlineReviewThread(...args);
				return Effect.void;
			},
			getPullRequestHeadSha: (...args) => {
				spies.getPullRequestHeadSha(...args);
				return Effect.succeed(headSha);
			},
		}),
	);
}

function makeReviewQueue(submitSpy?: ReturnType<typeof vi.fn>): Layer.Layer<ReviewQueue> {
	return Layer.succeed(
		ReviewQueue,
		ReviewQueue.of({
			submit: <A, E>(label: string, task: Effect.Effect<A, E>) => {
				submitSpy?.(label);
				return task;
			},
		}),
	);
}

function newSpies(): SurfaceSpies {
	return {
		acknowledgeOnPrConversation: vi.fn(),
		acknowledgeOnIssueComment: vi.fn(),
		acknowledgeOnReviewComment: vi.fn(),
		postPrConversationComment: vi.fn(),
		replyOnInlineReviewThread: vi.fn(),
		getPullRequestHeadSha: vi.fn(),
	};
}

function baseCtx(overrides: Partial<SlashContext> = {}): SlashContext {
	return {
		cfg,
		token: "tok",
		owner: "o",
		repo: "r",
		botUserId: 1,
		commenterId: 7,
		commentId: 99,
		body: "/help",
		replyTarget: { kind: "prConversation", prNumber: 3 },
		...overrides,
	};
}

describe("runSlashCommandFlow", () => {
	it("self-suppresses when commenter is the bot, never touching the surface", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(baseCtx({ commenterId: 1, botUserId: 1, body: "/help" })).pipe(
				Effect.provide(makeSurface(spies)),
				Effect.provide(makeReviewQueue()),
			),
		);
		expect(spies.acknowledgeOnPrConversation).not.toHaveBeenCalled();
		expect(spies.acknowledgeOnIssueComment).not.toHaveBeenCalled();
		expect(spies.postPrConversationComment).not.toHaveBeenCalled();
	});

	it("returns silently for non-slash bodies", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(baseCtx({ body: "just a comment" })).pipe(
				Effect.provide(makeSurface(spies)),
				Effect.provide(makeReviewQueue()),
			),
		);
		expect(spies.acknowledgeOnPrConversation).not.toHaveBeenCalled();
		expect(spies.getPullRequestHeadSha).not.toHaveBeenCalled();
	});

	it("/help on PR conversation: acks both surfaces and posts help via issue comment", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(baseCtx({ body: "/help" })).pipe(
				Effect.provide(makeSurface(spies)),
				Effect.provide(makeReviewQueue()),
			),
		);
		expect(spies.acknowledgeOnPrConversation).toHaveBeenCalledWith("tok", "o", "r", 3);
		expect(spies.acknowledgeOnIssueComment).toHaveBeenCalledWith("tok", "o", "r", 99);
		expect(spies.postPrConversationComment).toHaveBeenCalledWith(
			"tok",
			"o",
			"r",
			3,
			expect.stringContaining("PR Agent help"),
		);
		expect(spies.replyOnInlineReviewThread).not.toHaveBeenCalled();
	});

	it("/help on inline review thread: acks review-comment surface and replies in thread", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(
				baseCtx({
					body: "/help",
					replyTarget: { kind: "inlineReviewThread", prNumber: 3, inReplyToCommentId: 99 },
				}),
			).pipe(
				Effect.provide(makeSurface(spies)),
				Effect.provide(makeReviewQueue()),
			),
		);
		expect(spies.acknowledgeOnReviewComment).toHaveBeenCalledWith("tok", "o", "r", 99);
		expect(spies.replyOnInlineReviewThread).toHaveBeenCalledWith(
			"tok",
			"o",
			"r",
			3,
			99,
			expect.stringContaining("PR Agent help"),
		);
		expect(spies.acknowledgeOnIssueComment).not.toHaveBeenCalled();
		expect(spies.postPrConversationComment).not.toHaveBeenCalled();
	});

	it("unknown command posts an ephemeral note via the right reply target", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(baseCtx({ body: "/whatever" })).pipe(
				Effect.provide(makeSurface(spies)),
				Effect.provide(makeReviewQueue()),
			),
		);
		expect(spies.postPrConversationComment).toHaveBeenCalledWith(
			"tok",
			"o",
			"r",
			3,
			expect.stringContaining("Unknown command `/whatever`"),
		);
	});

	it("/review submits runFullPrReview through the ReviewQueue with the resolved head SHA", async () => {
		const spies = newSpies();
		const submitSpy = vi.fn();
		const reviewSpy = vi
			.spyOn(reviewRun, "runFullPrReview")
			.mockResolvedValue({ lastAssistant: { role: "assistant", content: [], timestamp: 0 } as never });

		try {
			await Effect.runPromise(
				runSlashCommandFlow(baseCtx({ body: "/review take a look" })).pipe(
					Effect.provide(makeSurface(spies, "feedf00d")),
					Effect.provide(makeReviewQueue(submitSpy)),
				),
			);

			expect(submitSpy).toHaveBeenCalledTimes(1);
			expect(submitSpy).toHaveBeenCalledWith("o/r#3:slash");
			expect(reviewSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					owner: "o",
					repo: "r",
					prNumber: 3,
					headSha: "feedf00d",
					userSupplement: expect.stringContaining("/review take a look"),
				}),
			);
		} finally {
			reviewSpy.mockRestore();
		}
	});
});
