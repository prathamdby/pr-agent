import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { createOperationLogger } from "../src/evlog.js";
import { WebhookHandlers, WebhookHandlersCore } from "../src/effect/services/webhookHandlers.js";
import type { WorkflowRunWebhookPayload } from "../src/webhook/payloads/workflowRunEvent.js";
import { makeTestConfig } from "./helpers/config.js";

const cfg = makeTestConfig();

function handlerLayers(scheduler: Layer.Layer<AgentWorkScheduler>) {
  return WebhookHandlersCore.pipe(Layer.provide(scheduler));
}

describe("WebhookHandlers.workflowRun PR filtering", () => {
  it("passes only matching, deduped PR numbers to submitCiRefresh", async () => {
    const captured: Array<{
      readonly headSha: string;
      readonly prNumbers: readonly number[];
      readonly owner: string;
      readonly repo: string;
      readonly installationId: number;
    }> = [];

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

    const data: WorkflowRunWebhookPayload = {
      action: "completed",
      installation: { id: 9 },
      repository: { owner: { login: "acme" }, name: "pr-agent" },
      workflow_run: {
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

    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.workflowRun(
          cfg,
          {
            event: "workflow_run",
            delivery: "d-wr-1",
            rawBody: Buffer.from("{}"),
          },
          data,
          intakeLog,
        );
      }).pipe(Effect.provide(handlerLayers(scheduler))),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
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

  it("forwards an empty prNumbers list when no PR heads match", async () => {
    const captured: Array<readonly number[]> = [];
    const scheduler = Layer.succeed(
      AgentWorkScheduler,
      AgentWorkScheduler.of({
        recordIgnored: () => Effect.void,
        submitAutomatedReview: () => Effect.void,
        submitSlashCommand: () => Effect.void,
        submitCiRefresh: (_headers, data) =>
          Effect.sync(() => {
            captured.push(data.prNumbers);
          }),
        ping: () => Effect.succeed(true),
      }),
    );

    const data: WorkflowRunWebhookPayload = {
      action: "completed",
      installation: { id: 1 },
      repository: { owner: { login: "o" }, name: "r" },
      workflow_run: {
        id: 1,
        head_sha: "sha-a",
        status: "completed",
        conclusion: "failure",
        pull_requests: [{ number: 3, head: { sha: "other" } }],
      },
    };

    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.workflowRun(
          cfg,
          {
            event: "workflow_run",
            delivery: "d-wr-2",
            rawBody: Buffer.from("{}"),
          },
          data,
          intakeLog,
        );
      }).pipe(Effect.provide(handlerLayers(scheduler))),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(captured).toEqual([[]]);
  });
});
