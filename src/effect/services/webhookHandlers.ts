import { Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import type { RequestLogger } from "../../evlog.js";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import { parseSlashCommand } from "../../commands/parseSlashCommand.js";
import { isSlashAssociationAllowed } from "../../commands/slashAssociation.js";
import { AgentWorkScheduler } from "../../agentWork/scheduler.js";
import type { WebhookHeaders } from "../../agentWork/types.js";
import { getAppBotIdentity } from "../../github/appAuth.js";
import type { ParsedGithubEvent } from "../../webhook/parseGithubPayload.js";

type PullRequestData = Extract<ParsedGithubEvent, { name: "pull_request" }>["data"];
type IssueCommentData = Extract<ParsedGithubEvent, { name: "issue_comment" }>["data"];
type PullRequestReviewCommentData = Extract<
  ParsedGithubEvent,
  { name: "pull_request_review_comment" }
>["data"];

function codeAnchorFromReviewComment(
  comment: PullRequestReviewCommentData["comment"],
): CodeAnchor | undefined {
  if (comment.path == null || comment.line == null) return undefined;
  return {
    path: comment.path,
    line: comment.line,
    startLine: comment.start_line ?? undefined,
    side: comment.side,
    diffHunk: comment.diff_hunk,
  };
}

export class WebhookHandlers extends Context.Tag("WebhookHandlers")<
  WebhookHandlers,
  {
    readonly pullRequest: (
      cfg: Config,
      headers: WebhookHeaders,
      data: PullRequestData,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
    readonly issueComment: (
      cfg: Config,
      headers: WebhookHeaders,
      data: IssueCommentData,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
    readonly pullRequestReviewComment: (
      cfg: Config,
      headers: WebhookHeaders,
      data: PullRequestReviewCommentData,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
  }
>() {}

export const WebhookHandlersCore = Layer.effect(
  WebhookHandlers,
  Effect.gen(function* () {
    const scheduler = yield* AgentWorkScheduler;

    const ignoreBotSlash = (
      cfg: Config,
      headers: WebhookHeaders,
      commenterId: number,
      intakeLog: RequestLogger,
    ) =>
      Effect.gen(function* () {
        const botUserId = yield* Effect.tryPromise({
          try: async () => (await getAppBotIdentity(cfg)).userId,
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        });
        if (commenterId !== botUserId) return false;
        yield* scheduler.recordIgnored(headers, "ignored_bot_slash_command", intakeLog);
        return true;
      });

    const ignoreUnauthorizedSlash = (
      cfg: Config,
      headers: WebhookHeaders,
      association: string | null | undefined,
      intakeLog: RequestLogger,
    ) =>
      Effect.gen(function* () {
        if (isSlashAssociationAllowed(cfg.slashAllowedAssociations, association)) {
          return false;
        }
        yield* scheduler.recordIgnored(headers, "ignored_unauthorized_slash", intakeLog);
        return true;
      });

    return WebhookHandlers.of({
      pullRequest: (_cfg, headers, data, intakeLog) =>
        Effect.gen(function* () {
          yield* scheduler.submitAutomatedReview(
            headers,
            {
              owner: data.repository.owner.login,
              repo: data.repository.name,
              prNumber: data.pull_request.number,
              headSha: data.pull_request.head.sha,
              installationId: data.installation.id,
              repositorySizeKb: data.repository.size,
            },
            data.action ?? "",
            intakeLog,
          );
        }),

      issueComment: (cfg, headers, data, intakeLog) =>
        Effect.gen(function* () {
          if (data.action !== "created") {
            yield* scheduler.recordIgnored(
              headers,
              `ignored_issue_comment_${data.action}`,
              intakeLog,
            );
            return;
          }
          const body = data.comment.body ?? "";
          const command = parseSlashCommand(body);
          if (!command) {
            yield* scheduler.recordIgnored(headers, "ignored_no_slash_command", intakeLog);
            return;
          }
          if (yield* ignoreBotSlash(cfg, headers, data.comment.user.id, intakeLog)) return;
          if (
            yield* ignoreUnauthorizedSlash(cfg, headers, data.comment.author_association, intakeLog)
          ) {
            return;
          }

          yield* scheduler.submitSlashCommand(
            {
              headers,
              installationId: data.installation.id,
              owner: data.repository.owner.login,
              repo: data.repository.name,
              repositorySizeKb: data.repository.size,
              prNumber: data.issue.number,
              commenterId: data.comment.user.id,
              commentId: data.comment.id,
              body,
              command,
              replyTarget: {
                kind: "prConversation",
                prNumber: data.issue.number,
              },
              ...(command === "triage" ? { triageScope: "all" as const } : {}),
            },
            intakeLog,
          );
        }),

      pullRequestReviewComment: (cfg, headers, data, intakeLog) =>
        Effect.gen(function* () {
          if (data.action !== "created") {
            yield* scheduler.recordIgnored(
              headers,
              `ignored_review_comment_${data.action}`,
              intakeLog,
            );
            return;
          }
          const body = data.comment.body ?? "";
          const command = parseSlashCommand(body);
          if (!command) {
            if (!cfg.enableThreadReplies) {
              yield* scheduler.recordIgnored(headers, "ignored_no_slash_command", intakeLog);
              return;
            }
            if (data.comment.in_reply_to_id == null) {
              yield* scheduler.recordIgnored(headers, "ignored_no_slash_command", intakeLog);
              return;
            }
            if (
              yield* ignoreUnauthorizedSlash(
                cfg,
                headers,
                data.comment.author_association,
                intakeLog,
              )
            ) {
              return;
            }
            const threadRootCommentId = data.comment.in_reply_to_id;
            const storedReviewMatchHint = yield* scheduler.lookupStoredInlineReviewHint(
              data.repository.owner.login,
              data.repository.name,
              data.pull_request.number,
              data.comment.pull_request_review_id,
            );
            yield* scheduler.submitThreadReplyClassification(
              {
                headers,
                installationId: data.installation.id,
                owner: data.repository.owner.login,
                repo: data.repository.name,
                repositorySizeKb: data.repository.size,
                prNumber: data.pull_request.number,
                commenterId: data.comment.user.id,
                commentId: data.comment.id,
                authorAssociation: data.comment.author_association ?? null,
                body,
                replyTarget: {
                  kind: "inlineReviewThread",
                  prNumber: data.pull_request.number,
                  inReplyToCommentId: threadRootCommentId,
                },
                codeAnchor: codeAnchorFromReviewComment(data.comment),
                inReplyToCommentId: threadRootCommentId,
                pullRequestReviewId: data.comment.pull_request_review_id ?? null,
                storedReviewMatchHint,
              },
              intakeLog,
            );
            return;
          }
          if (yield* ignoreBotSlash(cfg, headers, data.comment.user.id, intakeLog)) return;
          if (
            yield* ignoreUnauthorizedSlash(cfg, headers, data.comment.author_association, intakeLog)
          ) {
            return;
          }

          const inlineReplyImmediateParentId = data.comment.in_reply_to_id ?? data.comment.id;

          yield* scheduler.submitSlashCommand(
            {
              headers,
              installationId: data.installation.id,
              owner: data.repository.owner.login,
              repo: data.repository.name,
              repositorySizeKb: data.repository.size,
              prNumber: data.pull_request.number,
              commenterId: data.comment.user.id,
              commentId: data.comment.id,
              body,
              command,
              replyTarget: {
                kind: "inlineReviewThread",
                prNumber: data.pull_request.number,
                inReplyToCommentId: inlineReplyImmediateParentId,
              },
              codeAnchor: codeAnchorFromReviewComment(data.comment),
              ...(command === "triage"
                ? {
                    triageScope:
                      data.comment.in_reply_to_id != null ? ("thread" as const) : undefined,
                    threadAnchorCommentId: data.comment.in_reply_to_id ?? undefined,
                    needsThreadRootResolution: data.comment.in_reply_to_id != null,
                  }
                : {}),
            },
            intakeLog,
          );
        }),
    });
  }),
);

export const WebhookHandlersLive = WebhookHandlersCore;
