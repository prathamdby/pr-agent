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
import { prNumbersForWorkflowRunHead } from "../../webhook/payloads/workflowRunEvent.js";

const resolveBotIdentityEffect = (cfg: Config) =>
  Effect.tryPromise({
    try: async () => getAppBotIdentity(cfg),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

type PullRequestData = Extract<ParsedGithubEvent, { name: "pull_request" }>["data"];
type IssueCommentData = Extract<ParsedGithubEvent, { name: "issue_comment" }>["data"];
type PullRequestReviewCommentData = Extract<
  ParsedGithubEvent,
  { name: "pull_request_review_comment" }
>["data"];
type WorkflowRunData = Extract<ParsedGithubEvent, { name: "workflow_run" }>["data"];

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
    readonly workflowRun: (
      cfg: Config,
      headers: WebhookHeaders,
      data: WorkflowRunData,
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
        const bot = yield* resolveBotIdentityEffect(cfg);
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
     * Returns true when the comment was handled (ignored or ask submitted).
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
    ) =>
      Effect.gen(function* () {
        const bot = yield* gateSlashCommand(
          cfg,
          headers,
          input.commenterId,
          input.association,
          intakeLog,
        );
        if (!bot) return true;
        if (!commentMentionsBot(input.body, bot.login)) {
          yield* scheduler.recordIgnored(headers, "ignored_no_slash_command", intakeLog);
          return true;
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
            {
              pushBeforeSha: data.before,
              merged: data.pull_request.merged === true,
            },
          );
        }),

      issueComment: (cfg, headers, data, intakeLog) =>
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
                prNumber: data.issue.number,
                commentId: data.comment.id,
                replyTarget: {
                  kind: "prConversation",
                  prNumber: data.issue.number,
                },
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
              ...(command === "ask" ? { botLogin: bot.login } : {}),
            },
            intakeLog,
          );
        }),

      pullRequestReviewComment: (cfg, headers, data, intakeLog) =>
        Effect.gen(function* () {
          const body = data.comment.body ?? "";
          const command = parseSlashCommand(body);
          const inlineReplyImmediateParentId = data.comment.in_reply_to_id ?? data.comment.id;
          const replyTarget = {
            kind: "inlineReviewThread" as const,
            prNumber: data.pull_request.number,
            inReplyToCommentId: inlineReplyImmediateParentId,
          };
          const codeAnchor = codeAnchorFromReviewComment(data.comment);

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
                prNumber: data.pull_request.number,
                commentId: data.comment.id,
                replyTarget,
                codeAnchor,
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
              prNumber: data.pull_request.number,
              commenterId: data.comment.user.id,
              commentId: data.comment.id,
              body,
              command,
              replyTarget,
              codeAnchor,
              ...(command === "triage"
                ? {
                    triageScope:
                      data.comment.in_reply_to_id != null ? ("thread" as const) : undefined,
                    threadAnchorCommentId: data.comment.in_reply_to_id ?? undefined,
                    needsThreadRootResolution: data.comment.in_reply_to_id != null,
                  }
                : {}),
              ...(command === "ask" ? { botLogin: bot.login } : {}),
            },
            intakeLog,
          );
        }),

      workflowRun: (_cfg, headers, data, intakeLog) =>
        Effect.gen(function* () {
          const headSha = data.workflow_run.head_sha;
          const prNumbers = prNumbersForWorkflowRunHead(
            headSha,
            data.workflow_run.pull_requests ?? [],
          );
          yield* scheduler.submitCiRefresh(
            headers,
            {
              installationId: data.installation.id,
              owner: data.repository.owner.login,
              repo: data.repository.name,
              headSha,
              prNumbers,
            },
            intakeLog,
          );
        }),
    });
  }),
);
