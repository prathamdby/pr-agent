import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import type { Config } from "../src/config.js";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { BotIdentity } from "../src/effect/services/botIdentity.js";
import { createOperationLogger } from "../src/evlog.js";
import { IntakeLogger } from "../src/effect/intakeLogger.js";
import { WebhookHandlers, WebhookHandlersCore } from "../src/effect/services/webhookHandlers.js";

const cfg: Config = {
  port: 0,
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

const issueCommentData = {
  action: "created",
  installation: { id: 1 },
  repository: { owner: { login: "o" }, name: "r" },
  issue: { number: 1 },
  comment: { id: 99, user: { id: 7 }, body: "/help" },
} as never;

function handlerTestLayers(scheduler: Layer.Layer<AgentWorkScheduler>) {
	const bot = Layer.succeed(
		BotIdentity,
		BotIdentity.of({
			resolve: () => Effect.succeed({ userId: 42, login: "pr-agent[bot]" }),
			getUserId: () => Effect.succeed(42),
			getAppUserId: () => Effect.succeed(42),
		}),
	);
	return WebhookHandlersCore.pipe(Layer.provide(scheduler), Layer.provide(bot));
}

describe("WebhookHandlers Effect resolution", () => {
  it("propagates scheduler failure through Effect's error channel (no Promise escape)", async () => {
    const failingScheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () => Effect.void,
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () => Effect.fail(new Error("scheduler failed")),
      }),
    );

    const HandlersWithFailingScheduler = handlerTestLayers(failingScheduler);

    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.issueComment(
          cfg,
          { event: "issue_comment", delivery: "d1", rawBody: Buffer.from("{}") },
          issueCommentData,
        );
      }).pipe(Effect.provide(HandlersWithFailingScheduler), Effect.provideService(IntakeLogger, intakeLog)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect((failure.value as Error).message).toBe("scheduler failed");
      }
    }
  });

  it("records non-slash comments without enqueueing command work", async () => {
    let ignored = false;
    let slash = false;
    const scheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () =>
          Effect.sync(() => {
            ignored = true;
          }),
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () =>
          Effect.sync(() => {
            slash = true;
          }),
      }),
    );

    const Handlers = handlerTestLayers(scheduler);
    const nonSlash = { ...issueCommentData, comment: { id: 99, user: { id: 7 }, body: "hello" } } as never;

    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.issueComment(
          cfg,
          { event: "issue_comment", delivery: "d2", rawBody: Buffer.from("{}") },
          nonSlash,
        );
      }).pipe(Effect.provide(Handlers), Effect.provideService(IntakeLogger, intakeLog)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(ignored).toBe(true);
    expect(slash).toBe(false);
  });

  it("ignores slash commands from the bot before enqueueing work", async () => {
    let ignored = false;
    let slash = false;
    const scheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: (_headers, decision) =>
          Effect.sync(() => {
            if (decision === "ignored_bot_slash_command") ignored = true;
          }),
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () =>
          Effect.sync(() => {
            slash = true;
          }),
      }),
    );

    const Handlers = handlerTestLayers(scheduler);
    const botSlash = { ...issueCommentData, comment: { id: 99, user: { id: 42 }, body: "/help" } } as never;
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.issueComment(
          cfg,
          { event: "issue_comment", delivery: "d3", rawBody: Buffer.from("{}") },
          botSlash,
        );
      }).pipe(Effect.provide(Handlers), Effect.provideService(IntakeLogger, intakeLog)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(ignored).toBe(true);
    expect(slash).toBe(false);
  });
});
