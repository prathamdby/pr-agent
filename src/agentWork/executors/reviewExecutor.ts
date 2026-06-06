import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { runFullPrReview } from "../../review/reviewRun.js";
import { buildTrustedReviewContextForReview } from "../../review/reviewTrustedContext.js";
import { fetchReviewPreflightMetadata } from "../../review/reviewPreflightFiles.js";
import {
  reviewRetrySlashCommandForMode,
  reviewSummarySentinelForMode,
} from "../../review/reviewSchema.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordReviewPhaseSpan,
  setReviewRunMetricFields,
} from "../../review/reviewRunMetrics.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { logInfo, logWarn } from "../../evlog.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { tryLightweightAutoReviewCompletion } from "../reviewLightweightCompletion.js";
import {
  loadReviewExecutorPublishContext,
  recordPublishStep,
  shouldSkipWork,
} from "../repository.js";
import { buildStaleSlashReviewRescheduleResult } from "../reviewReschedule.js";
import { renderReviewFailureNotice } from "../../review/progressComment.js";
import {
  makeInstallationTokenRefresher,
  resolveWorkItemHeadSha,
  runDurableWorkItem,
} from "../durableJob.js";
import { getAppBotIdentity, getPullRequestHeadSha } from "../githubPrSurface.js";
import { type ReviewJobData, type ReviewWorkPayload } from "../types.js";
export async function executeReviewJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<ReviewJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "review",
    acceptItem: (item) => item.reviewLens != null,
    resolveHeadSha: resolveWorkItemHeadSha,
    execute: async (item, env) => {
      const reviewLens = item.reviewLens!;
      const payload = item.payload as ReviewWorkPayload;
      initReviewRunMetrics({
        provider: cfg.agentProvider,
        model: cfg.piModel,
        mode: reviewLens,
      });
      if (
        payload.source === "slash" &&
        !payload.staleHeadRescheduled &&
        payload.staleHeadReplacementWorkItemId
      ) {
        return buildStaleSlashReviewRescheduleResult(pool, item, env.installation.token);
      }
      const {
        publishState,
        shouldLinkToSummary,
        storedInlineFingerprints,
        summaryCommentGithubId: summaryCommentIdHint,
      } = await recordReviewPhaseSpan("db-read", () =>
        loadReviewExecutorPublishContext(pool, item.id, item.resourceKey, reviewLens),
      );
      const tokenState = { installation: env.installation };
      const headSha = env.headSha;
      let staleHeadAtPublish = false;
      const publishAbortState: { staleHead?: boolean } = {};

      if (payload.source === "auto") {
        const preflight = await recordReviewPhaseSpan("preflight", () =>
          fetchReviewPreflightMetadata(
            tokenState.installation.token,
            item.owner,
            item.repo,
            item.prNumber,
            { maxPrFilesListed: cfg.maxPrFilesListed },
          ),
        );
        const lightweightResult = await tryLightweightAutoReviewCompletion(pool, {
          item,
          reviewLens,
          token: tokenState.installation.token,
          preflight,
        });
        if (lightweightResult.handled) {
          logInfo("review_lightweight_completion", {
            owner: item.owner,
            repo: item.repo,
            pr: item.prNumber,
            reviewLens,
            published: lightweightResult.published,
          });
          setReviewRunMetricFields({
            published: lightweightResult.published,
            publishAttempts: 0,
            lightweight: true,
          });
          logReviewRunCompleted();
          return { degraded: false };
        }
      }

      const botIdentity = getAppBotIdentity(cfg);
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
          const bot = await botIdentity;
          const trustedContext = await buildTrustedReviewContextForReview({
            preflight: repositoryView.preflight,
            token: tokenState.installation.token,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            reviewLens,
            botUserId: bot.userId,
            onPriorFeedbackError: (error) => {
              logWarn("prior_inline_feedback_fetch_failed", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                reviewLens,
                message: error instanceof Error ? error.message : String(error),
              });
            },
          });

          const result = await runFullPrReview({
            cfg,
            token: tokenState.installation.token,
            tokenExpiresAtTs: tokenState.installation.expiresAtTs,
            tokenTtlMs: tokenState.installation.ttlMs,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            mode: reviewLens,
            userSupplement: payload.userSupplement,
            trustedContext,
            storedInlineFingerprints,
            cwd: repositoryView.agentCwd,
            workspace: repositoryView.workspace,
            shouldLinkToSummary,
            summaryCommentIdHint,
            initialPublishState: {
              inlinePublished: publishState.inlinePublished,
              published: publishState.summaryPublished,
              inlineReviewId: publishState.inlineReviewId,
            },
            recordPublishStep: (step, detail) =>
              recordPublishStep(pool, {
                workItemId: item.id,
                resourceKey: item.resourceKey,
                reviewLens,
                step,
                githubId: detail?.githubId,
                detail: detail?.meta,
              }),
            reviewSource: payload.source,
            staleHeadRescheduled: payload.staleHeadRescheduled,
            publishAbortState,
            shouldAbortPublish: async () => {
              if (await shouldSkipWork(pool, item)) return true;
              const latestHeadSha = await getPullRequestHeadSha(
                tokenState.installation.token,
                item.owner,
                item.repo,
                item.prNumber,
              );
              if (latestHeadSha !== headSha) {
                staleHeadAtPublish = true;
                publishAbortState.staleHead = true;
                return true;
              }
              return false;
            },
            refreshInstallationToken: makeInstallationTokenRefresher(
              cfg,
              item.installationId,
              tokenState,
            ),
          });
          if (staleHeadAtPublish && payload.source === "slash" && !payload.staleHeadRescheduled) {
            return buildStaleSlashReviewRescheduleResult(pool, item, tokenState.installation.token);
          }
          if (!result.published) {
            if (result.publishSuperseded) {
              logInfo("review_publish_superseded", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                publishAttempts: result.publishAttempts,
              });
            } else {
              logWarn("review_not_published", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                publishAttempts: result.publishAttempts,
                publishDegraded: true,
              });
            }
          }
          return { degraded: !result.published && !result.publishSuperseded };
        },
      );
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation) return;
      const reviewLens = item.reviewLens!;
      await upsertReviewSummaryComment(
        installation.token,
        item.owner,
        item.repo,
        item.prNumber,
        renderReviewFailureNotice({
          mode: reviewLens,
          retryCommand: reviewRetrySlashCommandForMode(reviewLens),
        }),
        reviewSummarySentinelForMode(reviewLens),
      );
    },
  });
}
