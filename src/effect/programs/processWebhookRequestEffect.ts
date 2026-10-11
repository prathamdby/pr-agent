import { Data, Duration, Effect } from "effect";
import { AgentWorkScheduler } from "../../agentWork/scheduler.js";
import type { WebhookHeaders } from "../../agentWork/types.js";
import { type Config, GITHUB_WEBHOOK_RESPONSE_MARGIN_MS } from "../../settings/index.js";
import { captureWebhookReceived } from "../../analytics/workCompleted.js";
import { emitOperationLogger, recordEvent, type RequestLogger } from "../../evlog.js";
import { WebhookParseError, parseGithubPayload } from "../../webhook/parseGithubPayload.js";
import { verifyGithubWebhookSignature } from "../../webhook/verifySignature.js";
import { toIntakeCommand } from "../../webhook/intakeCommand.js";
import { getAppBotIdentity } from "../../github/appAuth.js";
import { errorMessage } from "../../errors/errorMessage.js";
import { isRecord } from "../../util/typeGuards.js";

function webhookDuplicateReason(
  intakeLog: RequestLogger,
): "delivery_duplicate" | "body_duplicate" | undefined {
  const events = intakeLog.getContext().events;
  if (!Array.isArray(events)) return undefined;
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    const event = entry.event;
    if (event !== "deduped_delivery") continue;
    const key = entry.dedupeKey;
    const keyText = typeof key === "string" ? key : "";
    return keyText.startsWith("body:") ? "body_duplicate" : "delivery_duplicate";
  }
  return undefined;
}

function emitWebhookReceived(args: {
  readonly githubEvent: string;
  readonly delivery: string;
  readonly elapsedMs: number;
  readonly outcome: "accepted" | "duplicate" | "rejected";
  readonly reason?: string;
}): void {
  captureWebhookReceived({
    githubEvent: args.githubEvent,
    delivery: args.delivery,
    elapsedMs: args.elapsedMs,
    outcome: args.outcome,
    ...(args.reason != null ? { reason: args.reason } : {}),
  });
}

export type WebhookPostRequest = {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
};

export type WebhookResponseLike = {
  status: number;
  body: string;
  contentType?: string;
};

export type HandleWebhookInput = {
  readonly cfg: Config;
  readonly request: WebhookPostRequest;
  readonly intakeLog: RequestLogger;
};

class WebhookSignatureInvalid extends Data.TaggedError("WebhookSignatureInvalid") {}

class WebhookInvalidJson extends Data.TaggedError("WebhookInvalidJson") {}

class WebhookUnprocessable extends Data.TaggedError("WebhookUnprocessable") {}

class WebhookIntakeUnavailable extends Data.TaggedError("WebhookIntakeUnavailable")<{
  readonly reason: "failed" | "timeout";
}> {}

type DispatchInput = {
  readonly cfg: Config;
  readonly headers: WebhookHeaders;
  readonly intakeLog: RequestLogger;
  readonly payload: Record<string, unknown>;
  readonly githubEvent: string;
  readonly logDelivery: string;
};

const dispatchGithubEvent = Effect.fn("webhook.dispatch")(function* (input: DispatchInput) {
  const { cfg, headers, intakeLog, payload, githubEvent, logDelivery } = input;
  yield* Effect.annotateCurrentSpan({
    event: githubEvent,
    delivery_id: logDelivery,
  });
  yield* Effect.gen(function* () {
    const event = headers.event ?? "";
    if (!headers.delivery) {
      recordEvent(intakeLog, "missing_delivery_id_using_body_hash", undefined, "warn");
    }

    const parsed = yield* Effect.try({
      try: () => parseGithubPayload(event, payload),
      catch: (cause) => {
        if (cause instanceof WebhookParseError) {
          recordEvent(intakeLog, "webhook_parse_error", { event, message: cause.message }, "warn");
          return new WebhookUnprocessable();
        }
        const message = errorMessage(cause);
        recordEvent(
          intakeLog,
          "webhook_handler_error",
          { event, delivery: logDelivery, message },
          "error",
        );
        return new WebhookIntakeUnavailable({ reason: "failed" });
      },
    });

    const scheduler = yield* AgentWorkScheduler;
    if (parsed.name === "ignored") recordEvent(intakeLog, "ignored_event", { event }, "debug");
    let command = toIntakeCommand(cfg, headers, parsed);
    if (command.kind === "auth_required") {
      const bot = yield* Effect.tryPromise({
        try: () => getAppBotIdentity(cfg),
        catch: (cause) => {
          const message = errorMessage(cause);
          recordEvent(
            intakeLog,
            "webhook_handler_error",
            { event, delivery: logDelivery, message },
            "error",
          );
          return new WebhookIntakeUnavailable({ reason: "failed" });
        },
      });
      command = toIntakeCommand(cfg, headers, parsed, bot);
    }
    if (command.kind === "auth_required") {
      const message = "Bot identity did not resolve intake authorization";
      recordEvent(
        intakeLog,
        "webhook_handler_error",
        { event, delivery: logDelivery, message },
        "error",
      );
      return yield* new WebhookIntakeUnavailable({ reason: "failed" });
    }
    yield* scheduler.submit(command, intakeLog).pipe(
      Effect.mapError((err) => {
        const message = errorMessage(err);
        recordEvent(
          intakeLog,
          "webhook_handler_error",
          { event, delivery: logDelivery, message },
          "error",
        );
        return new WebhookIntakeUnavailable({ reason: "failed" });
      }),
    );
    return yield* Effect.annotateCurrentSpan({ outcome: "accepted" });
  }).pipe(Effect.tapError(() => Effect.annotateCurrentSpan({ outcome: "rejected" })));
});

function rejectedResponse(
  input: HandleWebhookInput,
  githubEvent: string,
  logDelivery: string,
  startedAt: number,
  response: WebhookResponseLike,
  event: string,
  webhook: Record<string, unknown>,
  reason: string,
) {
  return Effect.gen(function* () {
    input.intakeLog.set({ webhook });
    yield* Effect.promise(() => emitOperationLogger(input.intakeLog, { event }));
    const recordedElapsed = webhook.elapsedMs;
    emitWebhookReceived({
      githubEvent,
      delivery: logDelivery,
      elapsedMs: typeof recordedElapsed === "number" ? recordedElapsed : Date.now() - startedAt,
      outcome: "rejected",
      reason,
    });
    return response;
  });
}

const handleWebhook = Effect.fn("webhook.handle")(function* (input: HandleWebhookInput) {
  const startedAt = Date.now();
  const delivery = input.request.headers["x-github-delivery"];
  const githubEvent = input.request.headers["x-github-event"] ?? "";
  const logDelivery = delivery ?? "(missing)";
  const responseBudgetMs = Math.max(
    1,
    input.cfg.webhook.timeoutMs - GITHUB_WEBHOOK_RESPONSE_MARGIN_MS,
  );
  input.intakeLog.set({
    github: { event: githubEvent, delivery: logDelivery },
    webhook: { method: "POST", path: "/webhooks" },
    runtime: "effect",
  });
  yield* Effect.annotateCurrentSpan({
    event: githubEvent,
    delivery_id: logDelivery,
  });

  const admitted = Effect.gen(function* () {
    const sig = input.request.headers["x-hub-signature-256"];
    if (!verifyGithubWebhookSignature(input.cfg.webhook.secret, input.request.rawBody, sig)) {
      recordEvent(input.intakeLog, "invalid_signature", undefined, "warn");
      return yield* new WebhookSignatureInvalid();
    }

    const payload = yield* Effect.try({
      try: (): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(input.request.rawBody.toString("utf8"));
        if (!isRecord(parsed)) throw new Error("webhook payload must be an object");
        return parsed;
      },
      catch: () => {
        recordEvent(input.intakeLog, "invalid_json", undefined, "warn");
        return new WebhookInvalidJson();
      },
    });

    const headers = {
      ...(delivery === undefined ? {} : { delivery }),
      event: githubEvent,
      rawBody: input.request.rawBody,
    } satisfies WebhookHeaders;
    yield* dispatchGithubEvent({
      cfg: input.cfg,
      headers,
      intakeLog: input.intakeLog,
      payload,
      githubEvent,
      logDelivery,
    }).pipe(
      Effect.timeout(Duration.millis(responseBudgetMs)),
      Effect.catchTag("TimeoutError", () =>
        Effect.gen(function* () {
          recordEvent(
            input.intakeLog,
            "webhook_timeout_budget_exceeded",
            {
              event: githubEvent,
              delivery: logDelivery,
              budgetMs: input.cfg.webhook.timeoutMs,
              responseBudgetMs,
            },
            "warn",
          );
          return yield* new WebhookIntakeUnavailable({ reason: "timeout" });
        }),
      ),
    );

    const elapsedMs = Date.now() - startedAt;
    recordEvent(
      input.intakeLog,
      "webhook_handled",
      { event: githubEvent, delivery: logDelivery, ms: elapsedMs },
      "info",
    );
    const duplicateReason = webhookDuplicateReason(input.intakeLog);
    if (duplicateReason != null) {
      emitWebhookReceived({
        githubEvent,
        delivery: logDelivery,
        elapsedMs,
        outcome: "duplicate",
        reason: duplicateReason,
      });
    } else {
      const lastEvent = input.intakeLog.getContext().lastEvent;
      const ignored =
        typeof lastEvent === "string" && lastEvent.startsWith("ignored") ? lastEvent : undefined;
      emitWebhookReceived({
        githubEvent,
        delivery: logDelivery,
        elapsedMs,
        outcome: "accepted",
        ...(ignored != null ? { reason: ignored } : {}),
      });
    }
    input.intakeLog.set({
      webhook: {
        status: 200,
        elapsedMs,
        budgetExceeded: elapsedMs > input.cfg.webhook.timeoutMs,
        budgetMs: input.cfg.webhook.timeoutMs,
        responseBudgetMs,
      },
    });
    if (elapsedMs > input.cfg.webhook.timeoutMs) {
      recordEvent(
        input.intakeLog,
        "webhook_timeout_budget_exceeded",
        {
          event: githubEvent,
          delivery: logDelivery,
          ms: elapsedMs,
          budgetMs: input.cfg.webhook.timeoutMs,
        },
        "warn",
      );
    }
    yield* Effect.annotateCurrentSpan({
      outcome: duplicateReason != null ? "duplicate" : "accepted",
    });
    void emitOperationLogger(input.intakeLog, { event: "webhook_handled" }).catch(() => undefined);
    return { status: 200, body: "ok" } satisfies WebhookResponseLike;
  });

  return yield* admitted.pipe(
    Effect.tapError(() => Effect.annotateCurrentSpan({ outcome: "rejected" })),
    Effect.catchTags({
      WebhookSignatureInvalid: () =>
        rejectedResponse(
          input,
          githubEvent,
          logDelivery,
          startedAt,
          { status: 401, body: "invalid signature" },
          "invalid_signature",
          { status: 401, signatureInvalid: true },
          "invalid_signature",
        ),
      WebhookInvalidJson: () =>
        rejectedResponse(
          input,
          githubEvent,
          logDelivery,
          startedAt,
          { status: 400, body: "invalid json" },
          "invalid_json",
          { status: 400 },
          "invalid_json",
        ),
      WebhookUnprocessable: () => {
        const elapsedMs = Date.now() - startedAt;
        return rejectedResponse(
          input,
          githubEvent,
          logDelivery,
          startedAt,
          { status: 422, body: "unprocessable entity" },
          "webhook_parse_error",
          {
            status: 422,
            elapsedMs,
            parseError: true,
            responseBudgetMs,
          },
          "parse_error",
        );
      },
      WebhookIntakeUnavailable: (error) => {
        const elapsedMs = Date.now() - startedAt;
        const timedOut = error.reason === "timeout";
        return rejectedResponse(
          input,
          githubEvent,
          logDelivery,
          startedAt,
          { status: 503, body: "service unavailable" },
          timedOut ? "webhook_timeout_budget_exceeded" : "webhook_handler_error",
          {
            status: 503,
            elapsedMs,
            handlerFailed: !timedOut,
            timeout: timedOut,
            responseBudgetMs,
          },
          timedOut ? "timeout" : "handler_failed",
        );
      },
    }),
    Effect.ensuring(
      Effect.gen(function* () {
        if (input.intakeLog.getContext().emitted === true) return;
        const webhook: unknown = input.intakeLog.getContext().webhook;
        if (isRecord(webhook) && webhook.status === 200) return;
        const lastEvent = input.intakeLog.getContext().lastEvent;
        yield* Effect.promise(() =>
          emitOperationLogger(input.intakeLog, {
            event: typeof lastEvent === "string" ? lastEvent : "webhook_request_aborted",
          }),
        ).pipe(Effect.catch(() => Effect.void));
      }),
    ),
  );
});

export const processWebhookPostRequestEffect: (
  input: HandleWebhookInput,
) => Effect.Effect<WebhookResponseLike, never, AgentWorkScheduler> = handleWebhook;
