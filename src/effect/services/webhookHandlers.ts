import { Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import { handleIssueCommentEvent } from "../../webhook/handlers/issueComment.js";
import { handlePullRequestEvent } from "../../webhook/handlers/pullRequest.js";
import { handlePullRequestReviewCommentEvent } from "../../webhook/handlers/pullRequestReviewComment.js";
import type { ParsedGithubEvent } from "../../webhook/parseGithubPayload.js";
import { BotIdentity, BotIdentityLive } from "./botIdentity.js";

type PullRequestData = Extract<ParsedGithubEvent, { name: "pull_request" }>["data"];
type IssueCommentData = Extract<ParsedGithubEvent, { name: "issue_comment" }>["data"];
type PullRequestReviewCommentData = Extract<ParsedGithubEvent, { name: "pull_request_review_comment" }>["data"];

export class WebhookHandlers extends Context.Tag("WebhookHandlers")<
  WebhookHandlers,
  {
    readonly pullRequest: (cfg: Config, token: string, data: PullRequestData) => Effect.Effect<void, Error>;
    readonly issueComment: (cfg: Config, token: string, data: IssueCommentData) => Effect.Effect<void, Error>;
    readonly pullRequestReviewComment: (
      cfg: Config,
      token: string,
      data: PullRequestReviewCommentData,
    ) => Effect.Effect<void, Error>;
  }
>() {}

function runPromiseHandler<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<void>,
  args: TArgs,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => fn(...args),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

export const WebhookHandlersCore = Layer.effect(
  WebhookHandlers,
  Effect.gen(function* () {
    const botIdentity = yield* BotIdentity;

    return WebhookHandlers.of({
      pullRequest: (cfg, token, data) => runPromiseHandler(handlePullRequestEvent, [cfg, token, data]),
      issueComment: (cfg, token, data) =>
        Effect.gen(function* () {
          const botUserId = yield* botIdentity.getUserId(cfg, token);
          yield* runPromiseHandler(handleIssueCommentEvent, [cfg, token, data, { botUserId }]);
        }),
      pullRequestReviewComment: (cfg, token, data) =>
        Effect.gen(function* () {
          const botUserId = yield* botIdentity.getUserId(cfg, token);
          yield* runPromiseHandler(handlePullRequestReviewCommentEvent, [cfg, token, data, { botUserId }]);
        }),
    });
  }),
);

export const WebhookHandlersLive = WebhookHandlersCore.pipe(Layer.provide(BotIdentityLive));
