import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { createOperationLogger } from "../src/evlog.js";
import { WebhookHandlers, WebhookHandlersCore } from "../src/effect/services/webhookHandlers.js";
import type { IssueCommentWebhookPayload } from "../src/webhook/payloads/issueCommentEvent.js";
import type { PullRequestReviewCommentWebhookPayload } from "../src/webhook/payloads/pullRequestReviewCommentEvent.js";
import { makeTestConfig } from "./helpers/config.js";

const mocks = vi.hoisted(() => ({
  fetchReviewCommentParentGraph: vi.fn(),
  getAppBotIdentity: vi.fn(),
  mintInstallationAuth: vi.fn(),
}));

vi.mock("../src/review/run/reviewPriorFeedback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/run/reviewPriorFeedback.js")>();
  return {
    ...actual,
    fetchReviewCommentParentGraph: mocks.fetchReviewCommentParentGraph,
  };
});

vi.mock("../src/github/appAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/appAuth.js")>();
  return {
    ...actual,
    getAppBotIdentity: mocks.getAppBotIdentity,
    mintInstallationAuth: mocks.mintInstallationAuth,
  };
});

const cfg = makeTestConfig({
  maxAskFinalizeRounds: 6,
  askConcurrency: 1,
  enableReviewLabelsEffort: false,
});

const issueCommentData: IssueCommentWebhookPayload = {
  action: "created",
  installation: { id: 1 },
  repository: { owner: { login: "o" }, name: "r" },
  issue: { number: 1, pull_request: {} },
  comment: { id: 99, user: { id: 7 }, author_association: "MEMBER", body: "/help" },
};

const reviewCommentData: PullRequestReviewCommentWebhookPayload = {
  action: "created",
  installation: { id: 1 },
  repository: { owner: { login: "o" }, name: "r" },
  pull_request: { number: 1 },
  comment: {
    id: 100,
    user: { id: 7 },
    author_association: "MEMBER",
    body: "/help",
    path: "src/file.ts",
    line: 4,
    side: "RIGHT",
  },
};

function handlerTestLayers(scheduler: Layer.Layer<AgentWorkScheduler>) {
  return WebhookHandlersCore.pipe(Layer.provide(scheduler));
}

function slashTraceLayers(
  captureSlash?: (input: {
    replyTarget?: unknown;
    triageScope?: string;
    needsThreadRootResolution?: boolean;
  }) => void,
) {
  const trace: {
    decision?: string;
    ignored: boolean;
    slash: boolean;
    slashInput?: {
      replyTarget?: unknown;
      triageScope?: string;
      needsThreadRootResolution?: boolean;
    };
  } = { ignored: false, slash: false };
  const scheduler = Layer.succeed(
    AgentWorkScheduler,
    AgentWorkScheduler.of({
      recordIgnored: (_headers, decision) =>
        Effect.sync(() => {
          trace.decision = decision;
          trace.ignored = true;
        }),
      submitAutomatedReview: () => Effect.void,
      submitSlashCommand: (input) =>
        Effect.sync(() => {
          trace.slash = true;
          trace.slashInput = {
            replyTarget: input.replyTarget,
            triageScope: input.triageScope,
            needsThreadRootResolution: input.needsThreadRootResolution,
          };
          captureSlash?.({
            replyTarget: input.replyTarget,
            triageScope: input.triageScope,
            needsThreadRootResolution: input.needsThreadRootResolution,
          });
        }),
      lookupStoredInlineReviewHint: () => Effect.succeed(false),
      submitThreadReplyClassification: () => Effect.void,
      ping: () => Effect.succeed(true),
    }),
  );

  return { trace, handlers: handlerTestLayers(scheduler) };
}

async function runIssueComment(data: IssueCommentWebhookPayload, runCfg = cfg) {
  const { trace, handlers } = slashTraceLayers();
  const intakeLog = createOperationLogger({
    method: "POST",
    path: "/webhooks",
  });
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const resolvedHandlers = yield* WebhookHandlers;
      yield* resolvedHandlers.issueComment(
        runCfg,
        {
          event: "issue_comment",
          delivery: "d-author-issue",
          rawBody: Buffer.from("{}"),
        },
        data,
        intakeLog,
      );
    }).pipe(Effect.provide(handlers)),
  );

  return { exit, trace };
}

async function runReviewComment(
  data: PullRequestReviewCommentWebhookPayload,
  captureSlash?: (input: { replyTarget?: unknown; triageScope?: string }) => void,
) {
  const { trace, handlers } = slashTraceLayers(captureSlash);
  const intakeLog = createOperationLogger({
    method: "POST",
    path: "/webhooks",
  });
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const resolvedHandlers = yield* WebhookHandlers;
      yield* resolvedHandlers.pullRequestReviewComment(
        cfg,
        {
          event: "pull_request_review_comment",
          delivery: "d-author-review",
          rawBody: Buffer.from("{}"),
        },
        data,
        intakeLog,
      );
    }).pipe(Effect.provide(handlers)),
  );

  return { exit, trace };
}

describe("WebhookHandlers Effect resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 42, login: "pr-agent[bot]" });
    mocks.mintInstallationAuth.mockResolvedValue({
      token: "tok",
      expiresAtTs: Date.now() + 60_000,
      ttlMs: 60_000,
    });
    mocks.fetchReviewCommentParentGraph.mockResolvedValue([
      { id: 1, inReplyToId: null },
      { id: 2, inReplyToId: 1 },
    ]);
  });

  it("propagates scheduler failure through Effect's error channel (no Promise escape)", async () => {
    const failingScheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () => Effect.void,
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () => Effect.fail(new Error("scheduler failed")),
        lookupStoredInlineReviewHint: () => Effect.succeed(false),
        submitThreadReplyClassification: () => Effect.void,
        ping: () => Effect.succeed(true),
      }),
    );

    const HandlersWithFailingScheduler = handlerTestLayers(failingScheduler);

    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.issueComment(
          cfg,
          {
            event: "issue_comment",
            delivery: "d1",
            rawBody: Buffer.from("{}"),
          },
          issueCommentData,
          intakeLog,
        );
      }).pipe(Effect.provide(HandlersWithFailingScheduler)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value.message).toBe("scheduler failed");
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
        lookupStoredInlineReviewHint: () => Effect.succeed(false),
        submitThreadReplyClassification: () => Effect.void,
        ping: () => Effect.succeed(true),
      }),
    );

    const Handlers = handlerTestLayers(scheduler);
    const nonSlash = {
      ...issueCommentData,
      comment: { id: 99, user: { id: 7 }, body: "hello" },
    };

    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.issueComment(
          cfg,
          {
            event: "issue_comment",
            delivery: "d2",
            rawBody: Buffer.from("{}"),
          },
          nonSlash,
          intakeLog,
        );
      }).pipe(Effect.provide(Handlers)),
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
        lookupStoredInlineReviewHint: () => Effect.succeed(false),
        submitThreadReplyClassification: () => Effect.void,
        ping: () => Effect.succeed(true),
      }),
    );

    const Handlers = handlerTestLayers(scheduler);
    const botSlash = {
      ...issueCommentData,
      comment: { id: 99, user: { id: 42 }, body: "/help" },
    };
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.issueComment(
          cfg,
          {
            event: "issue_comment",
            delivery: "d3",
            rawBody: Buffer.from("{}"),
          },
          botSlash,
          intakeLog,
        );
      }).pipe(Effect.provide(Handlers)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(ignored).toBe(true);
    expect(slash).toBe(false);
  });

  it("ignores issue slash commands from disallowed author associations", async () => {
    const { exit, trace } = await runIssueComment({
      ...issueCommentData,
      comment: {
        ...issueCommentData.comment,
        author_association: "FIRST_TIME_CONTRIBUTOR",
      },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(trace.decision).toBe("ignored_unauthorized_slash");
    expect(trace.slash).toBe(false);
  });

  it("schedules issue slash commands from allowed author associations", async () => {
    const { exit, trace } = await runIssueComment(issueCommentData);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(trace.ignored).toBe(false);
    expect(trace.slash).toBe(true);
  });

  it("ignores issue slash commands with missing author association", async () => {
    const { exit, trace } = await runIssueComment({
      ...issueCommentData,
      comment: {
        id: issueCommentData.comment.id,
        user: issueCommentData.comment.user,
        body: issueCommentData.comment.body,
      },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(trace.decision).toBe("ignored_unauthorized_slash");
    expect(trace.slash).toBe(false);
  });

  it("allows all issue slash commands when the association allowlist is star", async () => {
    const allowAll = makeTestConfig({
      slashAllowedAssociations: new Set(["*"]),
    });
    const { exit, trace } = await runIssueComment(
      {
        ...issueCommentData,
        comment: {
          ...issueCommentData.comment,
          author_association: "NONE",
        },
      },
      allowAll,
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(trace.ignored).toBe(false);
    expect(trace.slash).toBe(true);
  });

  it("ignores review slash commands from disallowed author associations", async () => {
    const { exit, trace } = await runReviewComment({
      ...reviewCommentData,
      comment: {
        ...reviewCommentData.comment,
        author_association: "FIRST_TIME_CONTRIBUTOR",
      },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(trace.decision).toBe("ignored_unauthorized_slash");
    expect(trace.slash).toBe(false);
  });

  it("defers thread root resolution for scoped inline /triage replies", async () => {
    const { exit, trace } = await runReviewComment({
      ...reviewCommentData,
      comment: {
        ...reviewCommentData.comment,
        id: 3,
        body: "/triage",
        in_reply_to_id: 2,
      },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(trace.slash).toBe(true);
    expect(trace.slashInput?.triageScope).toBe("thread");
    expect(trace.slashInput?.needsThreadRootResolution).toBe(true);
    expect(trace.slashInput?.replyTarget).toEqual({
      kind: "inlineReviewThread",
      prNumber: 1,
      inReplyToCommentId: 2,
    });
    expect(mocks.mintInstallationAuth).not.toHaveBeenCalled();
    expect(mocks.fetchReviewCommentParentGraph).not.toHaveBeenCalled();
  });
});
