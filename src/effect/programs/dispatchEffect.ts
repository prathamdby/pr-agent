import { Effect } from "effect";
import type { Config } from "../../config.js";
import { recordEvent } from "../../evlog.js";
import { WebhookParseError, parseGithubPayload } from "../../webhook/parseGithubPayload.js";
import { IntakeLogger } from "../intakeLogger.js";
import { WebhookHandlers } from "../services/webhookHandlers.js";
import { AgentWorkScheduler } from "../../agentWork/scheduler.js";

export type DispatchEffectInput = {
  cfg: Config;
  headers: { delivery?: string; event?: string; rawBody: Buffer };
  payload: Record<string, unknown>;
};

export function dispatchGithubEventEffect(
  input: DispatchEffectInput,
): Effect.Effect<void, Error, AgentWorkScheduler | WebhookHandlers | IntakeLogger> {
  return Effect.gen(function* () {
    const { cfg, headers, payload } = input;
    const event = headers.event ?? "";
    const intakeLog = yield* IntakeLogger;

    if (!headers.delivery) {
      recordEvent(intakeLog, "missing_delivery_id_using_body_hash", undefined, "warn");
    }

    let parsed: ReturnType<typeof parseGithubPayload>;
    try {
      parsed = parseGithubPayload(event, payload);
    } catch (e) {
      if (e instanceof WebhookParseError) {
        recordEvent(intakeLog, "webhook_parse_error", { event, message: e.message }, "warn");
        return;
      }
      yield* Effect.fail(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    const scheduler = yield* AgentWorkScheduler;
    if (parsed.name === "ignored") {
      recordEvent(intakeLog, "ignored_event", { event }, "debug");
      yield* scheduler.recordIgnored(headers, `ignored_event_${event || "missing"}`, intakeLog);
      return;
    }

    const handlers = yield* WebhookHandlers;
    switch (parsed.name) {
      case "pull_request":
        yield* handlers.pullRequest(cfg, headers, parsed.data);
        return;
      case "issue_comment":
        yield* handlers.issueComment(cfg, headers, parsed.data);
        return;
      case "pull_request_review_comment":
        yield* handlers.pullRequestReviewComment(cfg, headers, parsed.data);
        return;
      default:
        parsed satisfies never;
    }
  });
}
