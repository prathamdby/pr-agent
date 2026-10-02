import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { createOperationLogger } from "../src/evlog.js";
import { WebhookHandlers, WebhookHandlersCore } from "../src/effect/services/webhookHandlers.js";
import type { PullRequestWebhookPayload } from "../src/webhook/payloads/pullRequestEvent.js";
import { makeTestConfig } from "./helpers/config.js";

const cfg = makeTestConfig();

function handlerLayers(scheduler: Layer.Layer<AgentWorkScheduler>) {
  return WebhookHandlersCore.pipe(Layer.provide(scheduler));
}

function basePrPayload(merged: boolean): PullRequestWebhookPayload {
  return {
    action: "closed",
    installation: { id: 9 },
    repository: {
      owner: { login: "acme" },
      name: "pr-agent",
      size: 100,
    },
    pull_request: {
      number: 11,
      head: { sha: "sha-head" },
      merged,
      state: "closed",
      updated_at: "2026-10-01T00:00:01Z",
    },
  };
}

describe("WebhookHandlers.pullRequest merged flag", () => {
  it("forwards merged:true as opts.merged for closed+merged deliveries", async () => {
    const captured: Array<{
      readonly action: string;
      readonly opts?: {
        readonly pushBeforeSha?: string;
        readonly merged?: boolean;
        readonly lifecycle?: { readonly state: string; readonly observedAt: string };
      };
    }> = [];

    const scheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        submitReviewApproved: () => Effect.void,
        recordIgnored: () => Effect.void,
        submitAutomatedReview: (_headers, _ref, action, _log, opts) =>
          Effect.sync(() => {
            captured.push({ action, opts });
          }),
        submitSlashCommand: () => Effect.void,
        submitCiRefresh: () => Effect.void,
        submitCiState: () => Effect.void,
        ping: () => Effect.succeed(true),
      }),
    );

    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.pullRequest(
          cfg,
          {
            event: "pull_request",
            delivery: "d-merged",
            rawBody: Buffer.from("{}"),
          },
          basePrPayload(true),
          intakeLog,
        );
      }).pipe(Effect.provide(handlerLayers(scheduler))),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.action).toBe("closed");
    expect(captured[0]?.opts?.merged).toBe(true);
    expect(captured[0]?.opts?.lifecycle).toEqual({
      state: "merged",
      observedAt: "2026-10-01T00:00:01Z",
    });
  });

  it("forwards merged:false when the closed payload is not merged", async () => {
    const captured: Array<{
      readonly action: string;
      readonly opts?: {
        readonly pushBeforeSha?: string;
        readonly merged?: boolean;
        readonly lifecycle?: { readonly state: string; readonly observedAt: string };
      };
    }> = [];

    const scheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        submitReviewApproved: () => Effect.void,
        recordIgnored: () => Effect.void,
        submitAutomatedReview: (_headers, _ref, action, _log, opts) =>
          Effect.sync(() => {
            captured.push({ action, opts });
          }),
        submitSlashCommand: () => Effect.void,
        submitCiRefresh: () => Effect.void,
        submitCiState: () => Effect.void,
        ping: () => Effect.succeed(true),
      }),
    );

    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.pullRequest(
          cfg,
          {
            event: "pull_request",
            delivery: "d-closed",
            rawBody: Buffer.from("{}"),
          },
          basePrPayload(false),
          intakeLog,
        );
      }).pipe(Effect.provide(handlerLayers(scheduler))),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.action).toBe("closed");
    expect(captured[0]?.opts?.merged).toBe(false);
    expect(captured[0]?.opts?.lifecycle).toEqual({
      state: "closed",
      observedAt: "2026-10-01T00:00:01Z",
    });
  });
});
