import { Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import { WebhookHandlerError } from "../errors.js";
import { dispatchGithubEventEffect } from "../programs/dispatchEffect.js";
import { DeliveryDedupe, DeliveryDedupeLive } from "./deliveryDedupe.js";
import { GithubInstallationToken, GithubInstallationTokenLive } from "./githubInstallationToken.js";
import { ReviewQueueLive } from "./reviewQueue.js";
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
    const dedupe = yield* DeliveryDedupe;
    const tokenSvc = yield* GithubInstallationToken;
    const handlers = yield* WebhookHandlers;

    return WebhookDispatcher.of({
      dispatch: (input) =>
        dispatchGithubEventEffect(input).pipe(
          Effect.provideService(DeliveryDedupe, dedupe),
          Effect.provideService(GithubInstallationToken, tokenSvc),
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

export const buildWebhookDispatcherLive = (cfg: Pick<Config, "reviewConcurrency">) =>
  DispatcherCore.pipe(
    Layer.provide(GithubInstallationTokenLive),
    Layer.provide(WebhookHandlersLive),
    Layer.provide(DeliveryDedupeLive),
    Layer.provide(ReviewQueueLive(cfg)),
  );
