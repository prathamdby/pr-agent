import { Duration, Effect } from "effect";
import { AgentWorkScheduler } from "../../agentWork/scheduler.js";
import type { WebhookHeaders } from "../../agentWork/types.js";
import type { Config } from "../../config.js";
import { captureEvent } from "../../analytics/index.js";
import { emitOperationLogger, recordEvent, type RequestLogger } from "../../evlog.js";
import { GITHUB_WEBHOOK_RESPONSE_MARGIN_MS, WEBHOOK_TIMEOUT_MS } from "../../settings/index.js";
import { WebhookParseError, parseGithubPayload } from "../../webhook/parseGithubPayload.js";
import { verifyGithubWebhookSignature } from "../../webhook/verifySignature.js";
import { WebhookHandlers } from "../services/webhookHandlers.js";

type DispatchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed" }
  | { readonly kind: "timeout" }
  | { readonly kind: "parse_error"; readonly message: string };

export type WebhookPostRequest = {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
};

export type WebhookResponseLike = {
  status: number;
  body: string;
  contentType?: string;
};

type DispatchInput = {
  readonly cfg: Config;
  readonly headers: WebhookHeaders;
  readonly intakeLog: RequestLogger;
  readonly payload: Record<string, unknown>;
};

function dispatchGithubEventEffect(
  input: DispatchInput,
): Effect.Effect<DispatchResult, Error, AgentWorkScheduler | WebhookHandlers> {
  return Effect.gen(function* () {
    const { cfg, headers, intakeLog, payload } = input;
    const event = headers.event ?? "";

    if (!headers.delivery) {
      recordEvent(intakeLog, "missing_delivery_id_using_body_hash", undefined, "warn");
    }

    let parsed: ReturnType<typeof parseGithubPayload>;
    try {
      parsed = parseGithubPayload(event, payload);
    } catch (e) {
      if (e instanceof WebhookParseError) {
        recordEvent(intakeLog, "webhook_parse_error", { event, message: e.message }, "warn");
        return { kind: "parse_error" as const, message: e.message };
      }
      yield* Effect.fail(e instanceof Error ? e : new Error(String(e)));
      return { kind: "failed" as const };
    }

    const scheduler = yield* AgentWorkScheduler;
    if (parsed.name === "ignored") {
      recordEvent(intakeLog, "ignored_event", { event }, "debug");
      yield* scheduler.recordIgnored(headers, `ignored_event_${event || "missing"}`, intakeLog);
      return { kind: "ok" as const };
    }

    const handlers = yield* WebhookHandlers;
    switch (parsed.name) {
      case "pull_request":
        yield* handlers.pullRequest(cfg, headers, parsed.data, intakeLog);
        return { kind: "ok" as const };
      case "issue_comment":
        yield* handlers.issueComment(cfg, headers, parsed.data, intakeLog);
        return { kind: "ok" as const };
      case "pull_request_review_comment":
        yield* handlers.pullRequestReviewComment(cfg, headers, parsed.data, intakeLog);
        return { kind: "ok" as const };
      case "workflow_run":
        yield* handlers.ciRefresh(
          headers,
          {
            installationId: parsed.data.installation.id,
            owner: parsed.data.repository.owner.login,
            repo: parsed.data.repository.name,
            headSha: parsed.data.workflow_run.head_sha,
            pullRequests: parsed.data.workflow_run.pull_requests ?? [],
          },
          intakeLog,
        );
        return { kind: "ok" as const };
      case "check_suite":
        yield* handlers.ciRefresh(
          headers,
          {
            installationId: parsed.data.installation.id,
            owner: parsed.data.repository.owner.login,
            repo: parsed.data.repository.name,
            headSha: parsed.data.check_suite.head_sha,
            pullRequests: parsed.data.check_suite.pull_requests ?? [],
          },
          intakeLog,
        );
        return { kind: "ok" as const };
      default:
        parsed satisfies never;
        recordEvent(intakeLog, "unhandled_parsed_event", { event }, "warn");
        yield* scheduler.recordIgnored(
          headers,
          `ignored_unhandled_${event || "missing"}`,
          intakeLog,
        );
        return { kind: "ok" as const };
    }
  });
}

export function processWebhookPostRequestEffect(
  cfg: Config,
  req: WebhookPostRequest,
  intakeLog: RequestLogger,
): Effect.Effect<WebhookResponseLike, never, AgentWorkScheduler | WebhookHandlers> {
  return Effect.gen(function* () {
    const delivery = req.headers["x-github-delivery"];
    const githubEvent = req.headers["x-github-event"] ?? "";
    const logDelivery = delivery ?? "(missing)";

    intakeLog.set({
      github: { event: githubEvent, delivery: logDelivery },
      webhook: { method: "POST", path: "/webhooks" },
      runtime: "effect",
    });

    const sig = req.headers["x-hub-signature-256"];
    if (!verifyGithubWebhookSignature(cfg.webhookSecret, req.rawBody, sig)) {
      recordEvent(intakeLog, "invalid_signature", undefined, "warn");
      const response = {
        status: 401,
        body: "invalid signature",
      } satisfies WebhookResponseLike;
      intakeLog.set({
        webhook: { status: response.status, signatureInvalid: true },
      });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "invalid_signature" }));
      return response;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      recordEvent(intakeLog, "invalid_json", undefined, "warn");
      const response = {
        status: 400,
        body: "invalid json",
      } satisfies WebhookResponseLike;
      intakeLog.set({ webhook: { status: response.status } });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "invalid_json" }));
      return response;
    }

    const t0 = Date.now();
    const responseBudgetMs = Math.max(1, WEBHOOK_TIMEOUT_MS - GITHUB_WEBHOOK_RESPONSE_MARGIN_MS);
    const headers = {
      ...(delivery === undefined ? {} : { delivery }),
      event: githubEvent,
      rawBody: req.rawBody,
    } satisfies WebhookHeaders;
    const dispatch = dispatchGithubEventEffect({
      cfg,
      headers,
      intakeLog,
      payload,
    });
    const result: DispatchResult = yield* dispatch.pipe(
      Effect.timeout(Duration.millis(responseBudgetMs)),
      Effect.catchTag("TimeoutException", () =>
        Effect.sync(() => {
          recordEvent(
            intakeLog,
            "webhook_timeout_budget_exceeded",
            {
              event: githubEvent,
              delivery: logDelivery,
              budgetMs: WEBHOOK_TIMEOUT_MS,
              responseBudgetMs,
            },
            "warn",
          );
          return { kind: "timeout" as const };
        }),
      ),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          const message = err instanceof Error ? err.message : String(err);
          recordEvent(
            intakeLog,
            "webhook_handler_error",
            {
              event: githubEvent,
              delivery: logDelivery,
              message,
            },
            "error",
          );
          return { kind: "failed" as const };
        }),
      ),
    );
    const elapsedMs = Date.now() - t0;

    switch (result.kind) {
      case "ok":
        break;
      case "parse_error": {
        const response = {
          status: 422,
          body: "unprocessable entity",
        } satisfies WebhookResponseLike;
        intakeLog.set({
          webhook: {
            status: response.status,
            elapsedMs,
            parseError: true,
            responseBudgetMs,
          },
        });
        yield* Effect.promise(() =>
          emitOperationLogger(intakeLog, { event: "webhook_parse_error" }),
        );
        return response;
      }
      case "failed":
      case "timeout": {
        const response = {
          status: 503,
          body: "service unavailable",
        } satisfies WebhookResponseLike;
        intakeLog.set({
          webhook: {
            status: response.status,
            elapsedMs,
            handlerFailed: result.kind === "failed",
            timeout: result.kind === "timeout",
            responseBudgetMs,
          },
        });
        yield* Effect.promise(() =>
          emitOperationLogger(intakeLog, {
            event:
              result.kind === "timeout"
                ? "webhook_timeout_budget_exceeded"
                : "webhook_handler_error",
          }),
        );
        return response;
      }
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }

    recordEvent(
      intakeLog,
      "webhook_handled",
      { event: githubEvent, delivery: logDelivery, ms: elapsedMs },
      "info",
    );
    captureEvent({
      distinctId: "server",
      event: "webhook received",
      properties: {
        github_event: githubEvent,
        delivery: logDelivery,
        elapsed_ms: elapsedMs,
      },
    });
    intakeLog.set({
      webhook: {
        status: 200,
        elapsedMs,
        budgetExceeded: elapsedMs > WEBHOOK_TIMEOUT_MS,
        budgetMs: WEBHOOK_TIMEOUT_MS,
        responseBudgetMs,
      },
    });
    if (elapsedMs > WEBHOOK_TIMEOUT_MS) {
      recordEvent(
        intakeLog,
        "webhook_timeout_budget_exceeded",
        {
          event: githubEvent,
          delivery: logDelivery,
          ms: elapsedMs,
          budgetMs: WEBHOOK_TIMEOUT_MS,
        },
        "warn",
      );
    }
    void emitOperationLogger(intakeLog, { event: "webhook_handled" }).catch(() => undefined);
    return { status: 200, body: "ok" } satisfies WebhookResponseLike;
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (intakeLog.getContext().emitted === true) return;
        const webhook = intakeLog.getContext().webhook as { status?: number } | undefined;
        if (webhook?.status === 200) return;
        const lastEvent = intakeLog.getContext().lastEvent;
        yield* Effect.promise(() =>
          emitOperationLogger(intakeLog, {
            event: typeof lastEvent === "string" ? lastEvent : "webhook_request_aborted",
          }),
        ).pipe(Effect.catchAll(() => Effect.void));
      }),
    ),
  );
}
