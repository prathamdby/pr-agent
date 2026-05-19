import { Effect } from "effect";
import type { Config } from "../../config.js";
import { log } from "../../log.js";
import { WebhookParseError, parseGithubPayload } from "../../webhook/parseGithubPayload.js";
import { WebhookHandlers } from "../services/webhookHandlers.js";
import { AgentWorkScheduler } from "../../agentWork/scheduler.js";

export type DispatchEffectInput = {
  cfg: Config;
  headers: { delivery?: string; event?: string; rawBody: Buffer };
  payload: Record<string, unknown>;
};

export function dispatchGithubEventEffect(
  input: DispatchEffectInput,
): Effect.Effect<void, Error, AgentWorkScheduler | WebhookHandlers> {
  return Effect.gen(function* () {
    const { cfg, headers, payload } = input;
    const event = headers.event ?? "";

    if (!headers.delivery) {
      log.warn("missing_delivery_id_using_body_hash");
    }

    let parsed: ReturnType<typeof parseGithubPayload>;
    try {
      parsed = parseGithubPayload(event, payload);
    } catch (e) {
      if (e instanceof WebhookParseError) {
        log.warn("webhook_parse_error", { event, message: e.message });
        return;
      }
      return yield* Effect.fail(e instanceof Error ? e : new Error(String(e)));
    }

    const scheduler = yield* AgentWorkScheduler;
    if (parsed.name === "ignored") {
      log.debug("ignored_event", { event });
      yield* scheduler.recordIgnored(headers, `ignored_event_${event || "missing"}`);
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
