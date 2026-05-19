import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { Config } from "../src/config.js";
import { PrGithubSurface } from "../src/effect/services/prGithubSurface.js";
import { AskQueue } from "../src/effect/services/askQueue.js";
import { ReviewQueue } from "../src/effect/services/reviewQueue.js";
import { runSlashCommandFlow, type SlashContext } from "../src/commands/slashCommandFlow.js";
import * as reviewRun from "../src/agent/reviewRun.js";
import * as askRun from "../src/agent/askRun.js";

const cfg: Config = {
	port: 0,
	githubAppId: "1",
	githubAppPrivateKey: "k",
	webhookSecret: "s",
	piProvider: "openai",
	piModel: "gpt-4o-mini",
	maxToolRounds: 24,
	maxFinalizeRounds: 6,
	maxReviewPublishAttempts: 3,
	reviewConcurrency: 2,
	askConcurrency: 3,
	maxAskToolRounds: 12,
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

function makeAskQueue(submitSpy?: ReturnType<typeof vi.fn>): Layer.Layer<AskQueue> {
	return Layer.succeed(
		AskQueue,
		AskQueue.of({
			submit: <A, E>(label: string, task: Effect.Effect<A, E>) => {
				submitSpy?.(label);
				return task;
			},
		}),
	);
}

function provideSlashLayers(spies: SurfaceSpies, opts?: {
	reviewSubmitSpy?: ReturnType<typeof vi.fn>;
	askSubmitSpy?: ReturnType<typeof vi.fn>;
	headSha?: string;
}) {
	return (effect: Effect.Effect<void, Error, PrGithubSurface | ReviewQueue | AskQueue>) =>
		effect.pipe(
			Effect.provide(makeSurface(spies, opts?.headSha)),
			Effect.provide(makeReviewQueue(opts?.reviewSubmitSpy)),
			Effect.provide(makeAskQueue(opts?.askSubmitSpy)),
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
		tokenExpiresAtTs: Date.now() + 3_600_000,
		tokenTtlMs: 3_600_000,
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
				provideSlashLayers(spies),
			),
		);
		expect(spies.acknowledgeOnPrConversation).not.toHaveBeenCalled();
		expect(spies.acknowledgeOnIssueComment).not.toHaveBeenCalled();
		expect(spies.postPrConversationComment).not.toHaveBeenCalled();
	});

	it("returns silently for non-slash bodies", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(baseCtx({ body: "just a comment" })).pipe(provideSlashLayers(spies)),
		);
		expect(spies.acknowledgeOnPrConversation).not.toHaveBeenCalled();
		expect(spies.getPullRequestHeadSha).not.toHaveBeenCalled();
	});

	it("/help on PR conversation: acks both surfaces and posts help via issue comment", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(baseCtx({ body: "/help" })).pipe(provideSlashLayers(spies)),
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
		expect(spies.getPullRequestHeadSha).not.toHaveBeenCalled();
	});

	it("/help on inline review thread: acks review-comment surface and replies in thread", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(
				baseCtx({
					body: "/help",
					replyTarget: { kind: "inlineReviewThread", prNumber: 3, inReplyToCommentId: 99 },
				}),
			).pipe(provideSlashLayers(spies)),
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
			runSlashCommandFlow(baseCtx({ body: "/whatever" })).pipe(provideSlashLayers(spies)),
		);
		expect(spies.postPrConversationComment).toHaveBeenCalledWith(
			"tok",
			"o",
			"r",
			3,
			expect.stringContaining("Unknown command `/whatever`"),
		);
		expect(spies.getPullRequestHeadSha).not.toHaveBeenCalled();
	});

	it("/help on inline review thread does not fetch head SHA", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(
				baseCtx({
					body: "/help",
					replyTarget: { kind: "inlineReviewThread", prNumber: 3, inReplyToCommentId: 99 },
				}),
			).pipe(provideSlashLayers(spies)),
		);
		expect(spies.getPullRequestHeadSha).not.toHaveBeenCalled();
	});

	it("/review-security submits security-mode runFullPrReview through the ReviewQueue", async () => {
		const spies = newSpies();
		const submitSpy = vi.fn();
		const reviewSpy = vi
			.spyOn(reviewRun, "runFullPrReview")
			.mockResolvedValue({
				lastAssistant: { role: "assistant", content: [], timestamp: 0 } as never,
				published: true,
				publishAttempts: 1,
			});

		try {
			await Effect.runPromise(
				runSlashCommandFlow(baseCtx({ body: "/review-security deep pass" })).pipe(
					provideSlashLayers(spies, { reviewSubmitSpy: submitSpy, headSha: "deadbeef" }),
				),
			);

			expect(submitSpy).toHaveBeenCalledWith("o/r#3:slash:security");
			expect(reviewSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: "review-security",
					headSha: "deadbeef",
					userSupplement: expect.stringContaining("/review-security"),
				}),
			);
		} finally {
			reviewSpy.mockRestore();
		}
	});

	it("/review submits runFullPrReview through the ReviewQueue with the resolved head SHA", async () => {
		const spies = newSpies();
		const submitSpy = vi.fn();
		const reviewSpy = vi
			.spyOn(reviewRun, "runFullPrReview")
			.mockResolvedValue({
				lastAssistant: { role: "assistant", content: [], timestamp: 0 } as never,
				published: true,
				publishAttempts: 1,
			});

		try {
			await Effect.runPromise(
				runSlashCommandFlow(baseCtx({ body: "/review take a look" })).pipe(
					provideSlashLayers(spies, { reviewSubmitSpy: submitSpy, headSha: "feedf00d" }),
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

	it("bare /ask posts usage hint", async () => {
		const spies = newSpies();
		await Effect.runPromise(
			runSlashCommandFlow(baseCtx({ body: "/ask" })).pipe(provideSlashLayers(spies)),
		);
		expect(spies.postPrConversationComment).toHaveBeenCalledWith(
			"tok",
			"o",
			"r",
			3,
			expect.stringContaining("/ask"),
		);
		expect(spies.getPullRequestHeadSha).not.toHaveBeenCalled();
	});

	it("/ask submits runAskRun through AskQueue and posts plain reply on inline thread", async () => {
		const spies = newSpies();
		const askSubmitSpy = vi.fn();
		const askSpy = vi.spyOn(askRun, "runAskRun").mockResolvedValue({
			answer: "It replaces formatDistanceToNow to avoid hydration mismatches.",
			replied: true,
		});

		try {
			await Effect.runPromise(
				runSlashCommandFlow(
					baseCtx({
						body: "/ask what is this for?",
						replyTarget: { kind: "inlineReviewThread", prNumber: 3, inReplyToCommentId: 99 },
						codeAnchor: {
							path: "apps/web/src/components/core/sessions/session-card.tsx",
							line: 3,
							diffHunk: "+import { useHydrationSafeDistance } from ...",
						},
					}),
				).pipe(provideSlashLayers(spies, { askSubmitSpy, headSha: "abc123" })),
			);

			expect(askSubmitSpy).toHaveBeenCalledWith("o/r#3:ask");
			expect(askSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					question: "what is this for?",
					headSha: "abc123",
					codeAnchor: expect.objectContaining({ path: expect.stringContaining("session-card") }),
				}),
			);
			expect(spies.replyOnInlineReviewThread).toHaveBeenCalledWith(
				"tok",
				"o",
				"r",
				3,
				99,
				expect.stringContaining("hydration"),
			);
			expect(spies.postPrConversationComment).not.toHaveBeenCalled();
		} finally {
			askSpy.mockRestore();
		}
	});

	it("/ask on PR conversation wraps answer with Question/Answer headers", async () => {
		const spies = newSpies();
		vi.spyOn(askRun, "runAskRun").mockResolvedValue({
			answer: "**Question:** what changed?\n\n**Answer:**\n\nThe auth middleware.",
			replied: true,
		});

		await Effect.runPromise(
			runSlashCommandFlow(baseCtx({ body: "/ask what changed?" })).pipe(
				provideSlashLayers(spies, { headSha: "sha1" }),
			),
		);

		expect(spies.postPrConversationComment).toHaveBeenCalledWith(
			"tok",
			"o",
			"r",
			3,
			expect.stringContaining("**Question:**"),
		);
	});
});
