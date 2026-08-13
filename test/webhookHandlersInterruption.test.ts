import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import type { SlashCommandInput } from "../src/agentWork/intake/slashIntake.js";
import { createOperationLogger } from "../src/evlog.js";
import { WebhookHandlers, WebhookHandlersCore } from "../src/effect/services/webhookHandlers.js";
import type { IssueCommentWebhookPayload } from "../src/webhook/payloads/issueCommentEvent.js";
import type { PullRequestReviewCommentWebhookPayload } from "../src/webhook/payloads/pullRequestReviewCommentEvent.js";
import { makeTestConfig } from "./helpers/config.js";
import * as reviewPriorFeedbackIo from "../src/github/reviewPriorFeedbackIo.js";
import * as appAuth from "../src/github/appAuth.js";
import type { ReplyTarget } from "../src/commands/replyTarget.js";

const cfg = makeTestConfig({
  askConcurrency: 1,
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

type SlashTraceInput = {
  replyTarget: ReplyTarget;
  triageScope?: SlashCommandInput["triageScope"];
  needsThreadRootResolution?: boolean;
};

type SlashTrace = {
  decision?: string;
  ignored: boolean;
  slash: boolean;
  slashInput?: SlashTraceInput;
};

function handlerTestLayers(scheduler: Layer.Layer<AgentWorkScheduler>) {
  return WebhookHandlersCore.pipe(Layer.provide(scheduler));
}

function slashTraceLayers(captureSlash?: (input: SlashTraceInput) => void) {
  const trace: SlashTrace = { ignored: false, slash: false };
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
          const slashInput: SlashTraceInput = {
            replyTarget: input.replyTarget,
          };
          if (input.triageScope !== undefined) slashInput.triageScope = input.triageScope;
          if (input.needsThreadRootResolution !== undefined) {
            slashInput.needsThreadRootResolution = input.needsThreadRootResolution;
          }
          trace.slashInput = slashInput;
          captureSlash?.(slashInput);
        }),
      submitCiRefresh: () => Effect.void,
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
  captureSlash?: (input: SlashTraceInput) => void,
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
    vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
      userId: 42,
      login: "pr-agent[bot]",
    });
    vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
      type: "token",
      tokenType: "installation",
      token: "tok",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      permissions: {},
      repositorySelection: "all",
      installationId: 1,
    });
    vi.spyOn(reviewPriorFeedbackIo, "fetchReviewCommentParentGraph").mockResolvedValue([
      { id: 1, inReplyToId: null },
      { id: 2, inReplyToId: 1 },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("propagates scheduler failure through Effect's error channel (no Promise escape)", async () => {
    const failingScheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () => Effect.void,
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () => Effect.fail(new Error("scheduler failed")),
        submitCiRefresh: () => Effect.void,
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
        submitCiRefresh: () => Effect.void,
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
        submitCiRefresh: () => Effect.void,
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
    expect(appAuth.mintInstallationAuth).not.toHaveBeenCalled();
    expect(reviewPriorFeedbackIo.fetchReviewCommentParentGraph).not.toHaveBeenCalled();
  });
});
