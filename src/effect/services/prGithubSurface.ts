import { Context, Effect, Layer } from "effect";
import { installationOctokit } from "../../github/appAuth.js";
import { logDebug } from "../../evlog.js";

const EYES = "eyes" as const;

function safeReact(thunk: () => Promise<unknown>): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await thunk();
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        if (status === 422 || status === 403) return;
        throw e;
      }
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

function tryRest<A>(thunk: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: thunk,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

export class PrGithubSurface extends Context.Tag("PrGithubSurface")<
  PrGithubSurface,
  {
    readonly acknowledgeOnPrConversation: (
      apiToken: string,
      owner: string,
      repo: string,
      prNumber: number,
    ) => Effect.Effect<void, Error>;
    readonly acknowledgeOnIssueComment: (
      apiToken: string,
      owner: string,
      repo: string,
      commentId: number,
    ) => Effect.Effect<void, Error>;
    readonly acknowledgeOnReviewComment: (
      apiToken: string,
      owner: string,
      repo: string,
      commentId: number,
    ) => Effect.Effect<void, Error>;
    readonly postPrConversationComment: (
      apiToken: string,
      owner: string,
      repo: string,
      prNumber: number,
      body: string,
    ) => Effect.Effect<void, Error>;
    readonly replyOnInlineReviewThread: (
      apiToken: string,
      owner: string,
      repo: string,
      prNumber: number,
      inReplyToCommentId: number,
      body: string,
    ) => Effect.Effect<{ commentId: number }, Error>;
    readonly getPullRequestHeadSha: (
      apiToken: string,
      owner: string,
      repo: string,
      prNumber: number,
    ) => Effect.Effect<string, Error>;
  }
>() {}

export const PrGithubSurfaceLive = Layer.succeed(
  PrGithubSurface,
  PrGithubSurface.of({
    acknowledgeOnPrConversation: (apiToken, owner, repo, prNumber) =>
      safeReact(() => {
        const octokit = installationOctokit(apiToken);
        return octokit.rest.reactions.createForIssue({
          owner,
          repo,
          issue_number: prNumber,
          content: EYES,
        });
      }),

    acknowledgeOnIssueComment: (apiToken, owner, repo, commentId) =>
      safeReact(() => {
        const octokit = installationOctokit(apiToken);
        return octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content: EYES,
        });
      }),

    acknowledgeOnReviewComment: (apiToken, owner, repo, commentId) =>
      safeReact(() => {
        const octokit = installationOctokit(apiToken);
        return octokit.rest.reactions.createForPullRequestReviewComment({
          owner,
          repo,
          comment_id: commentId,
          content: EYES,
        });
      }),

    postPrConversationComment: (apiToken, owner, repo, prNumber, body) =>
      tryRest(async () => {
        const octokit = installationOctokit(apiToken);
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        });
      }),

    replyOnInlineReviewThread: (apiToken, owner, repo, prNumber, inReplyToCommentId, body) =>
      tryRest(async () => {
        const octokit = installationOctokit(apiToken);
        const { data } = await octokit.rest.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: prNumber,
          comment_id: inReplyToCommentId,
          body,
        });
        logDebug("inline_review_reply_posted", {
          owner,
          repo,
          pr: prNumber,
          inReplyToCommentId,
          replyCommentId: data.id,
        });
        return { commentId: data.id };
      }),

    getPullRequestHeadSha: (apiToken, owner, repo, prNumber) =>
      tryRest(async () => {
        const octokit = installationOctokit(apiToken);
        const { data } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        });
        return data.head.sha;
      }),
  }),
);
