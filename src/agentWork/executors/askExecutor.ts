import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { runAskRun } from "../../agent/askRun.js";
import { formatAskFailureReply, sanitizeAskAnswerText } from "../../agent/formatAskReply.js";
import { installationOctokit } from "../../github/appAuth.js";
import { logWarn } from "../../evlog.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { makeInstallationTokenRefresher, runDurableWorkItem } from "../durableJob.js";
import { getPullRequestHeadSha, postSlashReply } from "../githubPrSurface.js";
import type { AgentWorkItem, AskJobData, AskWorkPayload } from "../types.js";

async function publishAskAnswer(
  token: string,
  item: AgentWorkItem,
  answer: string,
  alreadySanitized = false,
): Promise<void> {
  const body = alreadySanitized ? answer : sanitizeAskAnswerText(answer);
  const replyTarget = (item.payload as AskWorkPayload).replyTarget;
  if (replyTarget.kind === "inlineReviewThread") {
    try {
      await postSlashReply(token, item.owner, item.repo, replyTarget, body);
      return;
    } catch (e) {
      logWarn("ask_inline_reply_failed", {
        owner: item.owner,
        repo: item.repo,
        pr: replyTarget.prNumber,
        inReplyToCommentId: replyTarget.inReplyToCommentId,
        message: e instanceof Error ? e.message : String(e),
      });
      const octokit = installationOctokit(token);
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
  await postSlashReply(token, item.owner, item.repo, replyTarget, body);
}
export async function executeAskJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<AskJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "ask",
    resolveHeadSha: (token, item) =>
      getPullRequestHeadSha(token, item.owner, item.repo, item.prNumber),
    execute: async (item, env) => {
      const tokenState = { installation: env.installation };
      const headSha = env.headSha;
      const payload = item.payload as AskWorkPayload;
      return withPrRepositoryView(
        {
          cfg,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          installationToken: tokenState.installation.token,
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
          await publishAskAnswer(tokenState.installation.token, item, result.answer, true);
          return {};
        },
      );
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation) return;
      const payload = item.payload as AskWorkPayload;
      await publishAskAnswer(
        installation.token,
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
