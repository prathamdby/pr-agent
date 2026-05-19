import { Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import { AgentWorkSchedulerRuntimeLive } from "../../agentWork/runtime.js";
import { AgentWorkScheduler } from "../../agentWork/scheduler.js";
import { WebhookHandlerError } from "../errors.js";
import { dispatchGithubEventEffect } from "../programs/dispatchEffect.js";
import { WebhookHandlers, WebhookHandlersLive } from "./webhookHandlers.js";

export type DispatchInput = {
  cfg: Config;
  headers: {
    delivery?: string;
    event?: string;
    rawBody: Buffer;
  };
  payload: Record<string, unknown>;
};

export class WebhookDispatcher extends Context.Tag("WebhookDispatcher")<
  WebhookDispatcher,
  {
    readonly dispatch: (input: DispatchInput) => Effect.Effect<void, WebhookHandlerError>;
  }
>() {}

const DispatcherCore = Layer.effect(
  WebhookDispatcher,
  Effect.gen(function* () {
    const scheduler = yield* AgentWorkScheduler;
    const handlers = yield* WebhookHandlers;

    return WebhookDispatcher.of({
      dispatch: (input) =>
        dispatchGithubEventEffect(input).pipe(
          Effect.provideService(AgentWorkScheduler, scheduler),
          Effect.provideService(WebhookHandlers, handlers),
          Effect.mapError(
            (e) =>
              new WebhookHandlerError({
                cause: e,
                message: e instanceof Error ? e.message : String(e),
              }),
          ),
        ),
    });
  }),
);

export const buildWebhookDispatcherLive = (cfg: Config) =>
  DispatcherCore.pipe(
    Layer.provide(WebhookHandlersLive),
    Layer.provide(AgentWorkSchedulerRuntimeLive(cfg)),
  );
