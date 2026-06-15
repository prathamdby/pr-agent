import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import * as evlog from "../src/evlog.js";
import { IntakeLogger } from "../src/effect/server.js";
import { processWebhookPostRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { WebhookHandlers, WebhookHandlersCore } from "../src/effect/services/webhookHandlers.js";
import { makeTestConfig } from "./helpers/config.js";

const mocks = vi.hoisted(() => ({
  getAppBotIdentity: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/appAuth.js")>();
  return {
    ...actual,
    getAppBotIdentity: mocks.getAppBotIdentity,
  };
});

const cfg = makeTestConfig({
  webhookSecret: "secret",
  maxAskFinalizeRounds: 6,
  askConcurrency: 3,
});

function sign(body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", cfg.webhookSecret).update(body).digest("hex")}`;
}

function withIntake<R, E, A>(
  effect: Effect.Effect<A, E, R | AgentWorkScheduler | WebhookHandlers | IntakeLogger>,
  layer: Layer.Layer<AgentWorkScheduler | WebhookHandlers>,
) {
  const intakeLog = evlog.createOperationLogger({
    method: "POST",
    path: "/webhooks",
  });
  return effect.pipe(
    Effect.provide(layer),
    Effect.provideService(IntakeLogger, intakeLog),
  );
}

function slashGateLayer(
  decisions: string[],
  slashCalls: Array<{ command: string; body?: string; replyTarget?: unknown }>,
  opts: { botThreadMatch?: boolean } = {},
) {
  const schedulerLayer = Layer.succeed(
    AgentWorkScheduler,
    AgentWorkScheduler.of({
      recordIgnored: (_headers, decision) =>
        Effect.sync(() => {
          decisions.push(decision);
        }),
      submitAutomatedReview: () => Effect.void,
      submitSlashCommand: (input) =>
        Effect.sync(() => {
          slashCalls.push({
            command: input.command,
            body: input.body,
            replyTarget: input.replyTarget,
          });
        }),
      matchesStoredInlineReview: () => Effect.succeed(opts.botThreadMatch ?? false),
      ping: () => Effect.succeed(true),
    }),
  );
  const handlersLayer = WebhookHandlersCore.pipe(Layer.provide(schedulerLayer));

  return Layer.mergeAll(schedulerLayer, handlersLayer);
}

describe("processWebhookPostRequestEffect", () => {
  beforeEach(() => {
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 42, login: "pr-agent[bot]" });
  });

  const stubLayer = Layer.mergeAll(
    Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () => Effect.void,
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () => Effect.void,
        matchesStoredInlineReview: () => Effect.succeed(false),
        ping: () => Effect.succeed(true),
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
  );

  it("returns invalid signature", async () => {
    const body = Buffer.from("{}");
    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(cfg, {
          headers: { "x-hub-signature-256": "sha256=bad" },
          rawBody: body,
        }),
        stubLayer,
      ),
    );

    expect(out).toEqual({ status: 401, body: "invalid signature" });
  });

  it("returns ok for valid webhook", async () => {
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));
    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(cfg, {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "ping",
          },
          rawBody: body,
        }),
        stubLayer,
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
  });

  it("silently ignores unauthorized slash commands", async () => {
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      issue: { number: 3, pull_request: {} },
      comment: {
        id: 99,
        user: { id: 7 },
        author_association: "FIRST_TIME_CONTRIBUTOR",
        body: "/review",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{ command: string; body?: string; replyTarget?: unknown }> = [];

    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(cfg, {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "issue_comment",
            "x-github-delivery": "d-unauthorized-slash",
          },
          rawBody: body,
        }),
        slashGateLayer(decisions, slashCalls),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_unauthorized_slash"]);
    expect(slashCalls).toEqual([]);
  });

  it("ignores thread replies when ENABLE_THREAD_REPLIES is false", async () => {
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 7 },
        author_association: "MEMBER",
        body: "why is this P1?",
        in_reply_to_id: 100,
        pull_request_review_id: 55,
        path: "src/x.ts",
        line: 4,
        side: "RIGHT",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{ command: string; body?: string; replyTarget?: unknown }> = [];

    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(cfg, {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-off",
          },
          rawBody: body,
        }),
        slashGateLayer(decisions, slashCalls, { botThreadMatch: true }),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_no_slash_command"]);
    expect(slashCalls).toEqual([]);
  });

  it("submits ask for bot-thread reply when ENABLE_THREAD_REPLIES is true", async () => {
    const threadCfg = makeTestConfig({ enableThreadReplies: true });
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 7 },
        author_association: "MEMBER",
        body: "why is this P1?",
        in_reply_to_id: 100,
        pull_request_review_id: 55,
        path: "src/x.ts",
        line: 4,
        side: "RIGHT",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{ command: string; body?: string; replyTarget?: unknown }> = [];

    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(threadCfg, {
          headers: {
            "x-hub-signature-256": `sha256=${crypto
              .createHmac("sha256", threadCfg.webhookSecret)
              .update(body)
              .digest("hex")}`,
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-on",
          },
          rawBody: body,
        }),
        slashGateLayer(decisions, slashCalls, { botThreadMatch: true }),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual([]);
    expect(slashCalls).toEqual([
      {
        command: "ask",
        body: "why is this P1?",
        replyTarget: {
          kind: "inlineReviewThread",
          prNumber: 3,
          inReplyToCommentId: 100,
        },
      },
    ]);
  });

  it("ignores bot-authored thread replies", async () => {
    const threadCfg = makeTestConfig({ enableThreadReplies: true });
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 42 },
        author_association: "NONE",
        body: "auto reply",
        in_reply_to_id: 100,
        pull_request_review_id: 55,
        path: "src/x.ts",
        line: 4,
        side: "RIGHT",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{ command: string; body?: string; replyTarget?: unknown }> = [];

    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(threadCfg, {
          headers: {
            "x-hub-signature-256": `sha256=${crypto
              .createHmac("sha256", threadCfg.webhookSecret)
              .update(body)
              .digest("hex")}`,
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-bot",
          },
          rawBody: body,
        }),
        slashGateLayer(decisions, slashCalls, { botThreadMatch: true }),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_bot_slash_command"]);
    expect(slashCalls).toEqual([]);
  });

  it("ignores non-bot-thread replies", async () => {
    const threadCfg = makeTestConfig({ enableThreadReplies: true });
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 7 },
        author_association: "MEMBER",
        body: "human thread reply",
        in_reply_to_id: 100,
        pull_request_review_id: 99,
        path: "src/x.ts",
        line: 4,
        side: "RIGHT",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{ command: string; body?: string; replyTarget?: unknown }> = [];

    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(threadCfg, {
          headers: {
            "x-hub-signature-256": `sha256=${crypto
              .createHmac("sha256", threadCfg.webhookSecret)
              .update(body)
              .digest("hex")}`,
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-nonbot",
          },
          rawBody: body,
        }),
        slashGateLayer(decisions, slashCalls, { botThreadMatch: false }),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_non_bot_thread_reply"]);
    expect(slashCalls).toEqual([]);
  });

  it("submits ask when pull_request_review_id is null but bot thread matches", async () => {
    const threadCfg = makeTestConfig({ enableThreadReplies: true });
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 7 },
        author_association: "MEMBER",
        body: "why is this P1?",
        in_reply_to_id: 100,
        pull_request_review_id: null,
        path: "src/x.ts",
        line: 4,
        side: "RIGHT",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{ command: string; body?: string; replyTarget?: unknown }> = [];

    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(threadCfg, {
          headers: {
            "x-hub-signature-256": `sha256=${crypto
              .createHmac("sha256", threadCfg.webhookSecret)
              .update(body)
              .digest("hex")}`,
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-null-review-id",
          },
          rawBody: body,
        }),
        slashGateLayer(decisions, slashCalls, { botThreadMatch: true }),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual([]);
    expect(slashCalls[0]?.replyTarget).toEqual({
      kind: "inlineReviewThread",
      prNumber: 3,
      inReplyToCommentId: 100,
    });
  });

  it("returns 503 when handling exceeds the timeout budget", async () => {
    const slowLayer = Layer.mergeAll(
      Layer.succeed(
        AgentWorkScheduler,
        AgentWorkScheduler.of({
          recordIgnored: () => Effect.sleep("20 millis"),
          submitAutomatedReview: () => Effect.void,
          submitSlashCommand: () => Effect.void,
          matchesStoredInlineReview: () => Effect.succeed(false),
          ping: () => Effect.succeed(true),
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
    );

    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const tightCfg = { ...cfg, webhookTimeoutMs: 1 };
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const out = await Effect.runPromise(
        withIntake(
          processWebhookPostRequestEffect(tightCfg, {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
            rawBody: body,
          }),
          slowLayer,
        ),
      );

      expect(out).toEqual({ status: 503, body: "service unavailable" });
      const budgetWarn = recordSpy.mock.calls.find(
        (c) => c[1] === "webhook_timeout_budget_exceeded",
      );
      expect(budgetWarn).toBeDefined();
      expect(budgetWarn?.[2]).toMatchObject({ budgetMs: 1, responseBudgetMs: 1 });
    } finally {
      recordSpy.mockRestore();
    }
  });

  it("returns 503 when dispatch handling fails", async () => {
    const failingLayer = Layer.mergeAll(
      Layer.succeed(
        AgentWorkScheduler,
        AgentWorkScheduler.of({
          recordIgnored: () => Effect.fail(new Error("boom")),
          submitAutomatedReview: () => Effect.void,
          submitSlashCommand: () => Effect.void,
          matchesStoredInlineReview: () => Effect.succeed(false),
          ping: () => Effect.succeed(true),
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
    );

    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const out = await Effect.runPromise(
        withIntake(
          processWebhookPostRequestEffect(cfg, {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
            rawBody: body,
          }),
          failingLayer,
        ),
      );

      expect(out).toEqual({ status: 503, body: "service unavailable" });
      const errLog = recordSpy.mock.calls.find((c) => c[1] === "webhook_handler_error");
      expect(errLog).toBeDefined();
      expect(errLog?.[2]).toMatchObject({ message: "boom" });
    } finally {
      recordSpy.mockRestore();
    }
  });

  it("returns 200 before slow emitOperationLogger settles", async () => {
    let releaseEmit!: () => void;
    const emitGate = new Promise<void>((resolve) => {
      releaseEmit = resolve;
    });
    const emitSpy = vi.spyOn(evlog, "emitOperationLogger").mockImplementation(async () => {
      await emitGate;
    });
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const order: string[] = [];
      const responsePromise = Effect.runPromise(
        withIntake(
          processWebhookPostRequestEffect(cfg, {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
            rawBody: body,
          }),
          stubLayer,
        ),
      ).then((response) => {
        order.push("response");
        return response;
      });

      await Promise.resolve();
      const out = await responsePromise;
      expect(out).toEqual({ status: 200, body: "ok" });
      expect(order).toEqual(["response"]);
      expect(emitSpy).toHaveBeenCalledTimes(1);

      releaseEmit();
      await Promise.resolve();
    } finally {
      emitSpy.mockRestore();
    }
  });
});
