import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import * as evlog from "../src/evlog.js";
import { processWebhookPostRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { WebhookHandlers, WebhookHandlersCore } from "../src/effect/services/webhookHandlers.js";
import { makeTestConfig } from "./helpers/config.js";

const mocks = vi.hoisted(() => ({
  getAppBotIdentity: vi.fn(),
}));

const settingsOverrides: { webhookTimeoutMs?: number } = {};
vi.mock("../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/index.js")>();
  return {
    ...actual,
    get WEBHOOK_TIMEOUT_MS() {
      return settingsOverrides.webhookTimeoutMs ?? actual.WEBHOOK_TIMEOUT_MS;
    },
  };
});

vi.mock("../src/github/appAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/appAuth.js")>();
  return {
    ...actual,
    getAppBotIdentity: mocks.getAppBotIdentity,
  };
});

const cfg = makeTestConfig({
  webhookSecret: "secret",
  askConcurrency: 3,
});

function sign(body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", cfg.webhookSecret).update(body).digest("hex")}`;
}

function runWithIntake(
  req: Parameters<typeof processWebhookPostRequestEffect>[1],
  layer: Layer.Layer<AgentWorkScheduler | WebhookHandlers>,
  runCfg = cfg,
) {
  const intakeLog = evlog.createOperationLogger({
    method: "POST",
    path: "/webhooks",
  });
  return processWebhookPostRequestEffect(runCfg, req, intakeLog).pipe(Effect.provide(layer));
}

function slashGateLayer(
  decisions: string[],
  slashCalls: Array<{
    command: string;
    body?: string;
    replyTarget?: unknown;
    botLogin?: string;
  }>,
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
            botLogin: input.botLogin,
          });
        }),
      submitCiRefresh: () => Effect.void,
      ping: () => Effect.succeed(true),
    }),
  );
  const handlersLayer = WebhookHandlersCore.pipe(Layer.provide(schedulerLayer));

  return Layer.mergeAll(schedulerLayer, handlersLayer);
}

describe("processWebhookPostRequestEffect", () => {
  beforeEach(() => {
    mocks.getAppBotIdentity.mockReset();
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 42, login: "pr-agent[bot]" });
  });

  const stubLayer = Layer.mergeAll(
    Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () => Effect.void,
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () => Effect.void,
        submitCiRefresh: () => Effect.void,
        ping: () => Effect.succeed(true),
      }),
    ),
    Layer.succeed(
      WebhookHandlers,
      WebhookHandlers.of({
        pullRequest: () => Effect.void,
        issueComment: () => Effect.void,
        pullRequestReviewComment: () => Effect.void,
        ciRefresh: () => Effect.void,
      }),
    ),
  );

  it("returns invalid signature", async () => {
    const body = Buffer.from("{}");
    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: { "x-hub-signature-256": "sha256=bad" },
          rawBody: body,
        },
        stubLayer,
      ),
    );

    expect(out).toEqual({ status: 401, body: "invalid signature" });
  });

  it("returns ok for valid webhook", async () => {
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));
    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "ping",
          },
          rawBody: body,
        },
        stubLayer,
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
  });

  it("returns 422 for webhook parse errors", async () => {
    const body = Buffer.from(
      JSON.stringify({
        action: "opened",
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r", size: 10 },
        pull_request: { number: "not-a-number", head: { sha: "abc" } },
      }),
    );
    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "pull_request",
            "x-github-delivery": "d-parse-error",
          },
          rawBody: body,
        },
        stubLayer,
      ),
    );

    expect(out).toEqual({ status: 422, body: "unprocessable entity" });
  });

  it("returns 422 for non-integer pull request numbers", async () => {
    const body = Buffer.from(
      JSON.stringify({
        action: "opened",
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r", size: 10 },
        pull_request: { number: 1.5, head: { sha: "abc" } },
      }),
    );
    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "pull_request",
            "x-github-delivery": "d-float-pr-number",
          },
          rawBody: body,
        },
        stubLayer,
      ),
    );

    expect(out).toEqual({ status: 422, body: "unprocessable entity" });
  });

  it("returns 422 for pull request numbers that overflow Postgres integer", async () => {
    const body = Buffer.from(
      JSON.stringify({
        action: "opened",
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r", size: 10 },
        pull_request: { number: 2_147_483_648, head: { sha: "abc" } },
      }),
    );
    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "pull_request",
            "x-github-delivery": "d-overflow-pr-number",
          },
          rawBody: body,
        },
        stubLayer,
      ),
    );

    expect(out).toEqual({ status: 422, body: "unprocessable entity" });
  });

  function intakeFenceLayer(calls: string[]) {
    const schedulerLayer = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () =>
          Effect.sync(() => {
            calls.push("recordIgnored");
          }),
        submitAutomatedReview: () =>
          Effect.sync(() => {
            calls.push("submitAutomatedReview");
          }),
        submitSlashCommand: () =>
          Effect.sync(() => {
            calls.push("submitSlashCommand");
          }),
        submitCiRefresh: () =>
          Effect.sync(() => {
            calls.push("submitCiRefresh");
          }),
        ping: () => Effect.succeed(true),
      }),
    );
    const handlersLayer = Layer.succeed(
      WebhookHandlers,
      WebhookHandlers.of({
        pullRequest: () =>
          Effect.sync(() => {
            calls.push("pullRequest");
          }),
        issueComment: () =>
          Effect.sync(() => {
            calls.push("issueComment");
          }),
        pullRequestReviewComment: () =>
          Effect.sync(() => {
            calls.push("pullRequestReviewComment");
          }),
        ciRefresh: () =>
          Effect.sync(() => {
            calls.push("ciRefresh");
          }),
      }),
    );
    return Layer.mergeAll(schedulerLayer, handlersLayer);
  }

  it("returns 422 and skips durable work for invalid identifiers on every event", async () => {
    const cases = [
      {
        event: "issue_comment",
        delivery: "d-float-comment-id",
        payload: {
          action: "created",
          installation: { id: 1 },
          repository: { owner: { login: "o" }, name: "r", size: 10 },
          issue: { number: 3, pull_request: {} },
          comment: { id: 1.5, user: { id: 7 }, body: "/review" },
        },
      },
      {
        event: "workflow_run",
        delivery: "d-overflow-workflow-id",
        payload: {
          action: "completed",
          installation: { id: 1 },
          repository: { owner: { login: "o" }, name: "r", size: 10 },
          workflow_run: {
            id: 9_007_199_254_740_992,
            head_sha: "abc",
            status: "completed",
            conclusion: "failure",
            pull_requests: [{ number: 12, head: { sha: "abc" } }],
          },
        },
      },
      {
        event: "check_suite",
        delivery: "d-empty-check-sha",
        payload: {
          action: "completed",
          installation: { id: 1 },
          repository: { owner: { login: "o" }, name: "r", size: 10 },
          check_suite: {
            id: 55,
            head_sha: "",
            status: "completed",
            conclusion: "success",
            pull_requests: [{ number: 12, head: { sha: "abc" } }],
          },
        },
      },
      {
        event: "pull_request",
        delivery: "d-oversize-login",
        payload: {
          action: "opened",
          installation: { id: 1 },
          repository: { owner: { login: "o".repeat(40) }, name: "r", size: 10 },
          pull_request: { number: 3, head: { sha: "abc" } },
        },
      },
      {
        event: "workflow_run",
        delivery: "d-empty-workflow-sha",
        payload: {
          action: "completed",
          installation: { id: 1 },
          repository: { owner: { login: "o" }, name: "r", size: 10 },
          workflow_run: {
            id: 55,
            head_sha: "",
            status: "completed",
            conclusion: "failure",
            pull_requests: [{ number: 12, head: { sha: "abc" } }],
          },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const calls: string[] = [];
      const body = Buffer.from(JSON.stringify(testCase.payload));
      const out = await Effect.runPromise(
        runWithIntake(
          {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": testCase.event,
              "x-github-delivery": testCase.delivery,
            },
            rawBody: body,
          },
          intakeFenceLayer(calls),
        ),
      );
      expect(out).toEqual({ status: 422, body: "unprocessable entity" });
      expect(calls).toEqual([]);
    }
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
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "issue_comment",
            "x-github-delivery": "d-unauthorized-slash",
          },
          rawBody: body,
        },
        slashGateLayer(decisions, slashCalls),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_unauthorized_slash"]);
    expect(slashCalls).toEqual([]);
  });

  it("ignores bare inline thread reply without @mention", async () => {
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
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-no-mention",
          },
          rawBody: body,
        },
        slashGateLayer(decisions, slashCalls),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_no_slash_command"]);
    expect(slashCalls).toEqual([]);
    expect(mocks.getAppBotIdentity).toHaveBeenCalled();
  });

  it("submits ask for inline thread reply with @mention", async () => {
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 7 },
        author_association: "MEMBER",
        body: "@pr-agent[bot] why is this P1?",
        in_reply_to_id: 100,
        pull_request_review_id: 55,
        path: "src/x.ts",
        line: 4,
        side: "RIGHT",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{
      command: string;
      body?: string;
      replyTarget?: unknown;
      botLogin?: string;
    }> = [];

    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-mention",
          },
          rawBody: body,
        },
        slashGateLayer(decisions, slashCalls),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual([]);
    expect(slashCalls).toEqual([
      {
        command: "ask",
        body: "@pr-agent[bot] why is this P1?",
        replyTarget: {
          kind: "inlineReviewThread",
          prNumber: 3,
          inReplyToCommentId: 100,
        },
        botLogin: "pr-agent[bot]",
      },
    ]);
    expect(mocks.getAppBotIdentity).toHaveBeenCalled();
  });

  it("ignores bot-authored mention replies", async () => {
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 42 },
        author_association: "MEMBER",
        body: "@pr-agent[bot] why is this P1?",
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
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-bot-mention",
          },
          rawBody: body,
        },
        slashGateLayer(decisions, slashCalls),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_bot_slash_command"]);
    expect(slashCalls).toEqual([]);
    expect(mocks.getAppBotIdentity).toHaveBeenCalled();
  });

  it("rejects unauthorized mention replies", async () => {
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 7 },
        author_association: "NONE",
        body: "@pr-agent[bot] why is this P1?",
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
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "pull_request_review_comment",
            "x-github-delivery": "d-thread-unauthorized-mention",
          },
          rawBody: body,
        },
        slashGateLayer(decisions, slashCalls),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_unauthorized_slash"]);
    expect(slashCalls).toEqual([]);
    expect(mocks.getAppBotIdentity).toHaveBeenCalled();
  });

  it("submits ask for issue comment @mention without slash", async () => {
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      issue: { number: 3, pull_request: {} },
      comment: {
        id: 99,
        user: { id: 7 },
        author_association: "MEMBER",
        body: "@pr-agent hey",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{
      command: string;
      body?: string;
      replyTarget?: unknown;
      botLogin?: string;
    }> = [];

    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "issue_comment",
            "x-github-delivery": "d-issue-mention",
          },
          rawBody: body,
        },
        slashGateLayer(decisions, slashCalls),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual([]);
    expect(slashCalls).toEqual([
      {
        command: "ask",
        body: "@pr-agent hey",
        replyTarget: {
          kind: "prConversation",
          prNumber: 3,
        },
        botLogin: "pr-agent[bot]",
      },
    ]);
    expect(mocks.getAppBotIdentity).toHaveBeenCalled();
  });

  it("ignores issue_comment reply without @mention", async () => {
    const payload = {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r", size: 10 },
      issue: { number: 3, pull_request: { url: "x" } },
      comment: {
        id: 101,
        user: { id: 7 },
        author_association: "MEMBER",
        body: "just a regular reply",
        in_reply_to_id: 100,
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const decisions: string[] = [];
    const slashCalls: Array<{
      command: string;
      body?: string;
      replyTarget?: unknown;
      botLogin?: string;
    }> = [];

    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "issue_comment",
            "x-github-delivery": "d-issue-no-mention",
          },
          rawBody: body,
        },
        slashGateLayer(decisions, slashCalls),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(decisions).toEqual(["ignored_no_slash_command"]);
    expect(slashCalls).toEqual([]);
  });

  function ciRefreshCaptureLayer(
    captured: Array<{
      readonly headSha: string;
      readonly prNumbers: readonly number[];
      readonly owner: string;
      readonly repo: string;
      readonly installationId: number;
    }>,
  ) {
    const scheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () => Effect.void,
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () => Effect.void,
        submitCiRefresh: (_headers, data) =>
          Effect.sync(() => {
            captured.push({
              headSha: data.headSha,
              prNumbers: data.prNumbers,
              owner: data.owner,
              repo: data.repo,
              installationId: data.installationId,
            });
          }),
        ping: () => Effect.succeed(true),
      }),
    );
    return Layer.mergeAll(scheduler, WebhookHandlersCore.pipe(Layer.provide(scheduler)));
  }

  it("dispatches ciRefresh for completed check_suite with normalized head source", async () => {
    const captured: Array<{
      readonly headSha: string;
      readonly prNumbers: readonly number[];
      readonly owner: string;
      readonly repo: string;
      readonly installationId: number;
    }> = [];
    const payload = {
      action: "completed",
      installation: { id: 9 },
      repository: {
        name: "pr-agent",
        owner: { login: "acme" },
        size: 10,
      },
      check_suite: {
        id: 55,
        head_sha: "sha-a",
        status: "completed",
        conclusion: "success",
        pull_requests: [
          { number: 11, head: { sha: "sha-a" } },
          { number: 12, head: { sha: "sha-b" } },
          { number: 11, head: { sha: "sha-a" } },
        ],
      },
    };
    const body = Buffer.from(JSON.stringify(payload));

    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "check_suite",
            "x-github-delivery": "d-check-suite-ci",
          },
          rawBody: body,
        },
        ciRefreshCaptureLayer(captured),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(captured).toEqual([
      {
        headSha: "sha-a",
        prNumbers: [11],
        owner: "acme",
        repo: "pr-agent",
        installationId: 9,
      },
    ]);
  });

  it("dispatches ciRefresh for completed workflow_run with normalized head source", async () => {
    const captured: Array<{
      readonly headSha: string;
      readonly prNumbers: readonly number[];
      readonly owner: string;
      readonly repo: string;
      readonly installationId: number;
    }> = [];
    const payload = {
      action: "completed",
      installation: { id: 9 },
      repository: {
        name: "pr-agent",
        owner: { login: "acme" },
        size: 10,
      },
      workflow_run: {
        id: 55,
        head_sha: "sha-a",
        status: "completed",
        conclusion: "failure",
        pull_requests: [
          { number: 11, head: { sha: "sha-a" } },
          { number: 12, head: { sha: "sha-b" } },
          { number: 11, head: { sha: "sha-a" } },
        ],
      },
    };
    const body = Buffer.from(JSON.stringify(payload));

    const out = await Effect.runPromise(
      runWithIntake(
        {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "workflow_run",
            "x-github-delivery": "d-workflow-run-ci",
          },
          rawBody: body,
        },
        ciRefreshCaptureLayer(captured),
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
    expect(captured).toEqual([
      {
        headSha: "sha-a",
        prNumbers: [11],
        owner: "acme",
        repo: "pr-agent",
        installationId: 9,
      },
    ]);
  });

  it("returns 503 when handling exceeds the timeout budget", async () => {
    const slowLayer = Layer.mergeAll(
      Layer.succeed(
        AgentWorkScheduler,
        AgentWorkScheduler.of({
          recordIgnored: () => Effect.sleep("20 millis"),
          submitAutomatedReview: () => Effect.void,
          submitSlashCommand: () => Effect.void,
          submitCiRefresh: () => Effect.void,
          ping: () => Effect.succeed(true),
        }),
      ),
      Layer.succeed(
        WebhookHandlers,
        WebhookHandlers.of({
          pullRequest: () => Effect.void,
          issueComment: () => Effect.void,
          pullRequestReviewComment: () => Effect.void,
          ciRefresh: () => Effect.void,
        }),
      ),
    );

    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    settingsOverrides.webhookTimeoutMs = 1;
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const out = await Effect.runPromise(
        runWithIntake(
          {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
            rawBody: body,
          },
          slowLayer,
          cfg,
        ),
      );

      expect(out).toEqual({ status: 503, body: "service unavailable" });
      const budgetWarn = recordSpy.mock.calls.find(
        (c) => c[1] === "webhook_timeout_budget_exceeded",
      );
      expect(budgetWarn).toBeDefined();
      expect(budgetWarn?.[2]).toMatchObject({ budgetMs: 1, responseBudgetMs: 1 });
    } finally {
      delete settingsOverrides.webhookTimeoutMs;
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
          submitCiRefresh: () => Effect.void,
          ping: () => Effect.succeed(true),
        }),
      ),
      Layer.succeed(
        WebhookHandlers,
        WebhookHandlers.of({
          pullRequest: () => Effect.void,
          issueComment: () => Effect.void,
          pullRequestReviewComment: () => Effect.void,
          ciRefresh: () => Effect.void,
        }),
      ),
    );

    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const out = await Effect.runPromise(
        runWithIntake(
          {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
            rawBody: body,
          },
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
        runWithIntake(
          {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
            rawBody: body,
          },
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
