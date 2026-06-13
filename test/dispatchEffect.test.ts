import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { WebhookParseError } from "../src/webhook/parseGithubPayload.js";
import { createOperationLogger } from "../src/evlog.js";
import { dispatchGithubEventEffect } from "../src/effect/programs/dispatchEffect.js";
import { IntakeLogger } from "../src/effect/intakeLogger.js";
import { WebhookHandlers } from "../src/effect/services/webhookHandlers.js";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import * as parseModule from "../src/webhook/parseGithubPayload.js";
import { makeTestConfig } from "./helpers/config.js";

const cfg = makeTestConfig({
  port: 3000,
  maxAskFinalizeRounds: 6,
  enableReviewLabelsEffort: false,
});

type Trace = {
  recordIgnored: (...args: unknown[]) => void;
  submitAutomatedReview: (...args: unknown[]) => void;
  submitSlashCommand: (...args: unknown[]) => void;
  pullRequest: (...args: unknown[]) => void;
  issueComment: (...args: unknown[]) => void;
  pullRequestReviewComment: (...args: unknown[]) => void;
};

function buildLayers(trace: Trace) {
  const schedulerLayer = Layer.succeed(
    AgentWorkScheduler,
    AgentWorkScheduler.of({
      recordIgnored: (headers, decision, intakeLog) =>
        Effect.sync(() => {
          trace.recordIgnored(headers, decision, intakeLog);
        }),
      submitAutomatedReview: (headers, ref, action, intakeLog) =>
        Effect.sync(() => {
          trace.submitAutomatedReview(headers, ref, action, intakeLog);
        }),
      submitSlashCommand: (input, intakeLog) =>
        Effect.sync(() => {
          trace.submitSlashCommand(input, intakeLog);
        }),
      matchesStoredInlineReview: () => Effect.succeed(false),
      ping: () => Effect.succeed(true),
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

function runDispatch(input: Parameters<typeof dispatchGithubEventEffect>[0], trace: Trace) {
  const intakeLog = createOperationLogger({
    method: "POST",
    path: "/webhooks",
  });
  return dispatchGithubEventEffect(input).pipe(
    Effect.provide(buildLayers(trace)),
    Effect.provideService(IntakeLogger, intakeLog),
  );
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
        runDispatch(
          {
            cfg,
            headers: {
              event: "pull_request",
              delivery: "d0",
              rawBody: Buffer.from("{}"),
            },
            payload: {},
          },
          trace,
        ),
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
        runDispatch(
          {
            cfg,
            headers: {
              event: "ping",
              delivery: "d2",
              rawBody: Buffer.from("{}"),
            },
            payload: {},
          },
          trace,
        ),
      );

      expect(trace.recordIgnored).toHaveBeenCalledWith(
        { event: "ping", delivery: "d2", rawBody: expect.any(Buffer) },
        "ignored_event_ping",
        expect.anything(),
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
        runDispatch(
          {
            cfg,
            headers: {
              event: "pull_request",
              delivery: "d3",
              rawBody: Buffer.from("{}"),
            },
            payload: {},
          },
          trace,
        ),
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
