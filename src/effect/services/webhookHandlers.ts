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

const HandlersCore = Layer.effect(
  WebhookHandlers,
  Effect.gen(function* () {
    const botIdentity = yield* BotIdentity;

    const getBotUserId = (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
      installationToken: string,
    ): Promise<number> => Effect.runPromise(botIdentity.getUserId(cfg, installationToken));

    const handlerDeps = { getBotUserId };

    return WebhookHandlers.of({
      pullRequest: (cfg, token, data) =>
        Effect.tryPromise({
          try: () => handlePullRequestEvent(cfg, token, data),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
      issueComment: (cfg, token, data) =>
        Effect.tryPromise({
          try: () => handleIssueCommentEvent(cfg, token, data, handlerDeps),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
      pullRequestReviewComment: (cfg, token, data) =>
        Effect.tryPromise({
          try: () => handlePullRequestReviewCommentEvent(cfg, token, data, handlerDeps),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
    });
  }),
);

export const WebhookHandlersLive = HandlersCore.pipe(Layer.provide(BotIdentityLive));
