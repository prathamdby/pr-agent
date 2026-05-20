import { Effect } from "effect";
import type { Config } from "../config.js";
import { runAskRun, type CodeAnchor } from "../agent/askRun.js";
import { runFullPrReview } from "../agent/reviewRun.js";
import { AskQueue } from "../effect/services/askQueue.js";
import { PrGithubSurface } from "../effect/services/prGithubSurface.js";
import { logWarn, logError, logDebug } from "../evlog.js";
import { ReviewQueue } from "../effect/services/reviewQueue.js";
import { ASK_USAGE_HINT, parseAskQuestion } from "./parseAskQuestion.js";
import { parseSlashCommand } from "./parseSlashCommand.js";

export type ReplyTarget =
  | { readonly kind: "prConversation"; readonly prNumber: number }
  | {
      readonly kind: "inlineReviewThread";
      readonly prNumber: number;
      readonly inReplyToCommentId: number;
    };

export type SlashContext = {
  readonly cfg: Config;
  readonly token: string;
  readonly tokenExpiresAtTs: number;
  readonly tokenTtlMs: number;
  readonly owner: string;
  readonly repo: string;
  readonly botUserId: number;
  readonly commenterId: number;
  readonly commentId: number;
  readonly body: string;
  readonly replyTarget: ReplyTarget;
  readonly codeAnchor?: CodeAnchor;
};

export const slashHelpBody = [
  "### PR Agent help",
  "",
  "Commands (first line of a **new** comment):",
  "- `/help` — show this message",
  "- `/ask <question>` — ask about this PR or a specific line of code",
  "- `/review` — general bug-and-correctness review (also runs automatically on PR open/sync)",
  "- `/review-security` — deep security review (DeepSec-style; trigger-only, not auto-run)",
  "",
  "Notes:",
  "- Automated reviews use `/review`'s lens on PR `opened` / `synchronize` / `reopened`.",
  "- `/review` and `/review-security` can both leave summary comments on the same PR (different sentinels).",
  "- `/ask` answers one question at a time; it does not remember prior `/ask` commands.",
  "- Some security issues may appear in both passes; pick the command that matches your question.",
  "- Edited comments are ignored for slash parsing in v1.",
].join("\n");

export function runSlashCommandFlow(
  ctx: SlashContext,
): Effect.Effect<void, Error, PrGithubSurface | ReviewQueue | AskQueue> {
  return Effect.gen(function* () {
    if (ctx.commenterId === ctx.botUserId) return;

    const command = parseSlashCommand(ctx.body);
    if (!command) return;

    const surface = yield* PrGithubSurface;

    const postReply = (body: string) =>
      ctx.replyTarget.kind === "prConversation"
        ? surface.postPrConversationComment(
            ctx.token,
            ctx.owner,
            ctx.repo,
            ctx.replyTarget.prNumber,
            body,
          )
        : surface.replyOnInlineReviewThread(
            ctx.token,
            ctx.owner,
            ctx.repo,
            ctx.replyTarget.prNumber,
            ctx.replyTarget.inReplyToCommentId,
            body,
          );

    yield* surface.acknowledgeOnPrConversation(
      ctx.token,
      ctx.owner,
      ctx.repo,
      ctx.replyTarget.prNumber,
    );
    yield* ctx.replyTarget.kind === "prConversation"
      ? surface.acknowledgeOnIssueComment(ctx.token, ctx.owner, ctx.repo, ctx.commentId)
      : surface.acknowledgeOnReviewComment(ctx.token, ctx.owner, ctx.repo, ctx.commentId);

    if (command === "help") {
      yield* postReply(slashHelpBody);
      return;
    }

    if (command === "ask") {
      const question = parseAskQuestion(ctx.body);
      if (!question) {
        yield* postReply(ASK_USAGE_HINT);
        return;
      }

      const askQueue = yield* AskQueue;
      const queueLabel = `${ctx.owner}/${ctx.repo}#${ctx.replyTarget.prNumber}:ask`;

      const publishAskAnswer = (answer: string) =>
        Effect.gen(function* () {
          if (ctx.replyTarget.kind === "inlineReviewThread") {
            const inlineTarget = ctx.replyTarget;
            yield* surface
              .replyOnInlineReviewThread(
                ctx.token,
                ctx.owner,
                ctx.repo,
                inlineTarget.prNumber,
                inlineTarget.inReplyToCommentId,
                answer,
              )
              .pipe(
                Effect.catchAll((err) => {
                  const message = err instanceof Error ? err.message : String(err);
                  logWarn("ask_inline_reply_failed", {
                    owner: ctx.owner,
                    repo: ctx.repo,
                    pr: inlineTarget.prNumber,
                    inReplyToCommentId: inlineTarget.inReplyToCommentId,
                    message,
                  });
                  const fallback = [
                    "_Could not reply in the review thread; posting here instead._",
                    "",
                    answer,
                  ].join("\n");
                  return surface.postPrConversationComment(
                    ctx.token,
                    ctx.owner,
                    ctx.repo,
                    inlineTarget.prNumber,
                    fallback,
                  );
                }),
              );
            return;
          }
          yield* surface.postPrConversationComment(
            ctx.token,
            ctx.owner,
            ctx.repo,
            ctx.replyTarget.prNumber,
            answer,
          );
        });

      const askWork = askQueue
        .submit(
          queueLabel,
          Effect.gen(function* () {
            const headSha = yield* surface.getPullRequestHeadSha(
              ctx.token,
              ctx.owner,
              ctx.repo,
              ctx.replyTarget.prNumber,
            );
            const result = yield* Effect.tryPromise({
              try: () =>
                runAskRun({
                  cfg: ctx.cfg,
                  token: ctx.token,
                  tokenExpiresAtTs: ctx.tokenExpiresAtTs,
                  tokenTtlMs: ctx.tokenTtlMs,
                  owner: ctx.owner,
                  repo: ctx.repo,
                  prNumber: ctx.replyTarget.prNumber,
                  headSha,
                  question,
                  replyTarget: ctx.replyTarget,
                  codeAnchor: ctx.codeAnchor,
                }),
              catch: (e) => (e instanceof Error ? e : new Error(String(e))),
            });
            yield* publishAskAnswer(result.answer).pipe(Effect.uninterruptible);
            logDebug("ask_reply_delivered", {
              owner: ctx.owner,
              repo: ctx.repo,
              pr: ctx.replyTarget.prNumber,
              inline: ctx.replyTarget.kind === "inlineReviewThread",
            });
          }),
        )
        .pipe(
          Effect.tapError((err) =>
            Effect.sync(() => {
              const message = err instanceof Error ? err.message : String(err);
              logError("ask_background_failed", {
                owner: ctx.owner,
                repo: ctx.repo,
                pr: ctx.replyTarget.prNumber,
                message,
              });
            }),
          ),
          Effect.catchAll(() => Effect.void),
        );

      yield* Effect.forkDaemon(askWork);
      logDebug("ask_dispatched", {
        owner: ctx.owner,
        repo: ctx.repo,
        pr: ctx.replyTarget.prNumber,
        label: queueLabel,
      });
      return;
    }

    if (command === "review" || command === "review-security") {
      const headSha = yield* surface.getPullRequestHeadSha(
        ctx.token,
        ctx.owner,
        ctx.repo,
        ctx.replyTarget.prNumber,
      );
      const queueLabel =
        command === "review-security"
          ? `${ctx.owner}/${ctx.repo}#${ctx.replyTarget.prNumber}:slash:security`
          : `${ctx.owner}/${ctx.repo}#${ctx.replyTarget.prNumber}:slash`;
      const reviewQueue = yield* ReviewQueue;
      yield* reviewQueue.submit(
        queueLabel,
        Effect.tryPromise({
          try: () =>
            runFullPrReview({
              cfg: ctx.cfg,
              token: ctx.token,
              tokenExpiresAtTs: ctx.tokenExpiresAtTs,
              tokenTtlMs: ctx.tokenTtlMs,
              owner: ctx.owner,
              repo: ctx.repo,
              prNumber: ctx.replyTarget.prNumber,
              headSha,
              mode: command,
              userSupplement: `User invoked /${command} with:\n${ctx.body}`,
            }).then((result) => {
              if (!result.published) {
                logWarn("review_not_published", {
                  mode: command,
                  owner: ctx.owner,
                  repo: ctx.repo,
                  pr: ctx.replyTarget.prNumber,
                  publishAttempts: result.publishAttempts,
                });
              }
            }),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
      );
      return;
    }

    yield* postReply(`Unknown command \`/${command}\`. Try \`/help\` for available commands.`);
  });
}
