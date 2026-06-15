import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { posthog } from "../../posthog.js";
import { runAskRun } from "../../agent/ask/askRun.js";
import { formatAskFailureReply, sanitizeAskAnswerText } from "../../agent/ask/formatAskReply.js";
import { installationOctokit } from "../../github/appAuth.js";
import { logWarn } from "../../evlog.js";
import { ASK_PUBLISH_LENS } from "../../settings/index.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { makeInstallationTokenRefresher, runDurableWorkItem } from "../durableJob.js";
import { getPullRequestHead, postSlashReply } from "../githubPrSurface.js";
import { hasCompletedPublishStep, recordAskPublishStep } from "../repository.js";
import type { AgentWorkItem, AskJobData, AskWorkPayload } from "../types.js";

async function publishAskAnswer(
  token: string,
  tokenExpiresAtTs: number,
  item: AgentWorkItem,
  answer: string,
  alreadySanitized = false,
): Promise<void> {
  const body = alreadySanitized ? answer : sanitizeAskAnswerText(answer);
  const replyTarget = (item.payload as AskWorkPayload).replyTarget;
  if (replyTarget.kind === "inlineReviewThread") {
    try {
      await postSlashReply(token, item.owner, item.repo, replyTarget, body, tokenExpiresAtTs);
      return;
    } catch (e) {
      logWarn("ask_inline_reply_failed", {
        owner: item.owner,
        repo: item.repo,
        pr: replyTarget.prNumber,
        inReplyToCommentId: replyTarget.inReplyToCommentId,
        message: e instanceof Error ? e.message : String(e),
      });
      const octokit = installationOctokit(token, tokenExpiresAtTs);
      await octokit.rest.issues.createComment({
        owner: item.owner,
        repo: item.repo,
        issue_number: replyTarget.prNumber,
        body: ["_Could not reply in the review thread; posting here instead._", "", body].join(
          "\n",
        ),
      });
      return;
    }
  }
  await postSlashReply(token, item.owner, item.repo, replyTarget, body, tokenExpiresAtTs);
}
export async function executeAskJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<AskJobData>,
): Promise<void> {
  let answerDelivered = false;
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "ask",
    resolveHeadSha: (token, expiresAtTs, item) =>
      getPullRequestHead(token, item.owner, item.repo, item.prNumber, expiresAtTs),
    execute: async (item, env) => {
      const tokenState = { installation: env.installation };
      const headSha = env.headSha;
      const payload = item.payload as AskWorkPayload;
      const askReplyPublished = () =>
        hasCompletedPublishStep(pool, item.id, item.resourceKey, ASK_PUBLISH_LENS, "ask_reply");
      if (await askReplyPublished()) {
        answerDelivered = true;
        return {};
      }

      return withPrRepositoryView(
        {
          cfg,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          installationToken: tokenState.installation.token,
          installationExpiresAtTs: tokenState.installation.expiresAtTs,
          pullRequest: env.pullRequest,
          repositorySizeKb: payload.repositorySizeKb,
        },
        async (repositoryView) => {
          const result = await runAskRun({
            cfg,
            token: tokenState.installation.token,
            tokenExpiresAtTs: tokenState.installation.expiresAtTs,
            tokenTtlMs: tokenState.installation.ttlMs,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            question: payload.question,
            replyTarget: payload.replyTarget,
            codeAnchor: payload.codeAnchor,
            cwd: repositoryView.agentCwd,
            workspace: repositoryView.workspace,
            refreshInstallationToken: makeInstallationTokenRefresher(
              cfg,
              item.installationId,
              tokenState,
            ),
          });
          if (!(await askReplyPublished())) {
            await publishAskAnswer(
              tokenState.installation.token,
              tokenState.installation.expiresAtTs,
              item,
              result.answer,
              true,
            );
            answerDelivered = true;
            posthog.capture({
              distinctId: `installation:${item.installationId}`,
              event: "ask answered",
              properties: {
                owner: item.owner,
                repo: item.repo,
                pr_number: item.prNumber,
                reply_target_kind: payload.replyTarget.kind,
              },
            });
            try {
              await recordAskPublishStep(pool, {
                workItemId: item.id,
                resourceKey: item.resourceKey,
                step: "ask_reply",
                detail: { replyTargetKind: payload.replyTarget.kind },
              });
            } catch (e) {
              logWarn("ask_publish_record_failed", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                workItemId: item.id,
                message: e instanceof Error ? e.message : String(e),
              });
              return { degraded: true };
            }
          } else {
            answerDelivered = true;
          }
          return {};
        },
      );
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation || answerDelivered) return;
      const payload = item.payload as AskWorkPayload;
      await publishAskAnswer(
        installation.token,
        installation.expiresAtTs,
        item,
        formatAskFailureReply({
          question: payload.question,
          message: "PR Agent could not complete this ask after retries. Please try again later.",
          replyTarget: payload.replyTarget,
        }),
        true,
      );
    },
  });
}
