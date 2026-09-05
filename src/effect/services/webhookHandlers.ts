import { Context, Effect, Layer } from "effect";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import type { Config } from "../../config.js";
import type { RequestLogger } from "../../evlog.js";
import { parseSlashCommand } from "../../commands/parseSlashCommand.js";
import { commentMentionsBot } from "../../commands/parseBotMention.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import { isSlashAssociationAllowed } from "../../commands/slashAssociation.js";
import { AgentWorkScheduler } from "../../agentWork/scheduler.js";
import type { WebhookHeaders } from "../../agentWork/types.js";
import { getAppBotIdentity, type BotIdentity } from "../../github/appAuth.js";
import { IGNORED_BOT_SLASH_COMMAND, IGNORED_UNAUTHORIZED_SLASH } from "../../settings/index.js";
import type { ParsedGithubEvent } from "../../webhook/parseGithubPayload.js";
import { codeAnchorFromReviewComment } from "../../webhook/payloads/pullRequestReviewCommentEvent.js";
import {
  prNumbersForCiHead,
  type CiRefreshHeadSource,
} from "../../webhook/payloads/ciRefreshHead.js";

type PullRequestData = Extract<ParsedGithubEvent, { name: "pull_request" }>["data"];
type IssueCommentData = Extract<ParsedGithubEvent, { name: "issue_comment" }>["data"];
type PullRequestReviewCommentData = Extract<
  ParsedGithubEvent,
  { name: "pull_request_review_comment" }
>["data"];

/**
 * Per-event fields for the shared slash/mention machine.
 * `replyTarget` and triage thread ids are separate: inline replies use
 * `in_reply_to_id ?? comment.id`, while thread triage uses `in_reply_to_id` only.
 */
type CommentCommandFields = {
  readonly prNumber: number;
  readonly replyTarget: ReplyTarget;
  readonly codeAnchor?: CodeAnchor;
  readonly commenterLogin?: string;
  readonly triage:
    | { readonly scope: "all" }
    | {
        readonly scope: "thread" | undefined;
        readonly threadAnchorCommentId?: number;
        readonly needsThreadRootResolution: boolean;
      };
};

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
    /** CI cell refresh from a completed workflow_run or check_suite head. */
    readonly ciRefresh: (
      headers: WebhookHeaders,
      data: CiRefreshHeadSource,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
  }
>() {}

export const WebhookHandlersCore = Layer.effect(
  WebhookHandlers,
  Effect.gen(function* () {
    const scheduler = yield* AgentWorkScheduler;

    /**
     * Bot + association gate. Returns bot identity when intake may proceed, or null when gated.
     */
    const gateSlashCommand = (
      cfg: Config,
      headers: WebhookHeaders,
      commenterId: number,
      association: string | null | undefined,
      intakeLog: RequestLogger,
    ): Effect.Effect<BotIdentity | null, Error> =>
      Effect.gen(function* () {
        const bot = yield* Effect.tryPromise({
          try: async () => getAppBotIdentity(cfg),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        });
        if (commenterId === bot.userId) {
          yield* scheduler.recordIgnored(headers, IGNORED_BOT_SLASH_COMMAND, intakeLog);
          return null;
        }
        if (!isSlashAssociationAllowed(cfg.slashAllowedAssociations, association)) {
          yield* scheduler.recordIgnored(headers, IGNORED_UNAUTHORIZED_SLASH, intakeLog);
          return null;
        }
        return bot;
      });

    /**
     * No-slash path: `@bot` mention → ask intake (same allowlist as slash).
     */
    const handleMentionAskIfNeeded = (
      cfg: Config,
      headers: WebhookHeaders,
      input: {
        readonly commenterId: number;
        readonly association: string | null | undefined;
        readonly body: string;
        readonly installationId: number;
        readonly owner: string;
        readonly repo: string;
        readonly repositorySizeKb?: number;
        readonly prNumber: number;
        readonly commentId: number;
        readonly replyTarget: ReplyTarget;
        readonly codeAnchor?: CodeAnchor;
      },
      intakeLog: RequestLogger,
    ): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const bot = yield* gateSlashCommand(
          cfg,
          headers,
          input.commenterId,
          input.association,
          intakeLog,
        );
        if (!bot) return;
        if (!commentMentionsBot(input.body, bot.login)) {
          yield* scheduler.recordIgnored(headers, "ignored_no_slash_command", intakeLog);
          return;
        }
        yield* scheduler.submitSlashCommand(
          {
            headers,
            installationId: input.installationId,
            owner: input.owner,
            repo: input.repo,
            repositorySizeKb: input.repositorySizeKb,
            prNumber: input.prNumber,
            commenterId: input.commenterId,
            commentId: input.commentId,
            body: input.body,
            command: "ask",
            replyTarget: input.replyTarget,
            codeAnchor: input.codeAnchor,
            botLogin: bot.login,
          },
          intakeLog,
        );
      });

    const handleSlashOrMentionComment = (
      cfg: Config,
      headers: WebhookHeaders,
      data: IssueCommentData | PullRequestReviewCommentData,
      fields: CommentCommandFields,
      intakeLog: RequestLogger,
    ): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const body = data.comment.body ?? "";
        const command = parseSlashCommand(body);
        if (!command) {
          yield* handleMentionAskIfNeeded(
            cfg,
            headers,
            {
              commenterId: data.comment.user.id,
              association: data.comment.author_association,
              body,
              installationId: data.installation.id,
              owner: data.repository.owner.login,
              repo: data.repository.name,
              repositorySizeKb: data.repository.size,
              prNumber: fields.prNumber,
              commentId: data.comment.id,
              replyTarget: fields.replyTarget,
              codeAnchor: fields.codeAnchor,
            },
            intakeLog,
          );
          return;
        }
        const bot = yield* gateSlashCommand(
          cfg,
          headers,
          data.comment.user.id,
          data.comment.author_association,
          intakeLog,
        );
        if (!bot) return;

        yield* scheduler.submitSlashCommand(
          {
            headers,
            installationId: data.installation.id,
            owner: data.repository.owner.login,
            repo: data.repository.name,
            repositorySizeKb: data.repository.size,
            prNumber: fields.prNumber,
            commenterId: data.comment.user.id,
            commenterLogin: fields.commenterLogin,
            commentId: data.comment.id,
            body,
            command,
            replyTarget: fields.replyTarget,
            codeAnchor: fields.codeAnchor,
            ...(command === "triage"
              ? fields.triage.scope === "all"
                ? { triageScope: "all" as const }
                : {
                    triageScope: fields.triage.scope,
                    threadAnchorCommentId: fields.triage.threadAnchorCommentId,
                    needsThreadRootResolution: fields.triage.needsThreadRootResolution,
                  }
              : {}),
            ...(command === "ask" ? { botLogin: bot.login } : {}),
          },
          intakeLog,
        );
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
            {
              pushBeforeSha: data.before,
              merged: data.pull_request.merged,
            },
          );
        }),

      issueComment: (cfg, headers, data, intakeLog) =>
        handleSlashOrMentionComment(
          cfg,
          headers,
          data,
          {
            prNumber: data.issue.number,
            replyTarget: {
              kind: "prConversation",
              prNumber: data.issue.number,
            },
            commenterLogin: data.comment.user.login ?? undefined,
            triage: { scope: "all" },
          },
          intakeLog,
        ),

      pullRequestReviewComment: (cfg, headers, data, intakeLog) => {
        const inlineReplyImmediateParentId = data.comment.in_reply_to_id ?? data.comment.id;
        return handleSlashOrMentionComment(
          cfg,
          headers,
          data,
          {
            prNumber: data.pull_request.number,
            replyTarget: {
              kind: "inlineReviewThread",
              prNumber: data.pull_request.number,
              inReplyToCommentId: inlineReplyImmediateParentId,
            },
            codeAnchor: codeAnchorFromReviewComment(data.comment),
            commenterLogin: data.comment.user.login ?? undefined,
            triage: {
              scope: data.comment.in_reply_to_id != null ? ("thread" as const) : undefined,
              threadAnchorCommentId: data.comment.in_reply_to_id ?? undefined,
              needsThreadRootResolution: data.comment.in_reply_to_id != null,
            },
          },
          intakeLog,
        );
      },

      ciRefresh: (headers, data, intakeLog) =>
        scheduler.submitCiRefresh(
          headers,
          {
            installationId: data.installationId,
            owner: data.owner,
            repo: data.repo,
            headSha: data.headSha,
            prNumbers: prNumbersForCiHead(data.headSha, data.pullRequests),
          },
          intakeLog,
        ),
    });
  }),
);
