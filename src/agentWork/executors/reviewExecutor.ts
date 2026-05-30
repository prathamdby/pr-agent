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
  setReviewRunMetricFields,
} from "../../review/reviewRunMetrics.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { logInfo, logWarn } from "../../evlog.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { tryLightweightAutoReviewCompletion } from "../reviewLightweightCompletion.js";
import {
  getReviewPublishState,
  getStoredInlineFingerprints,
  getSummaryCommentGithubId,
  hasPriorCompletedSummaryPublish,
  recordPublishStep,
  shouldSkipWork,
} from "../repository.js";
import {
  createSlashReviewRescheduleWorkItem,
  enqueueSlashReviewReschedule,
} from "../reviewReschedule.js";
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
      if (
        payload.source === "slash" &&
        !payload.staleHeadRescheduled &&
        payload.staleHeadReplacementWorkItemId
      ) {
        const latestHeadSha = await getPullRequestHeadSha(
          env.installation.token,
          item.owner,
          item.repo,
          item.prNumber,
        );
        const replacementWorkItemId = await createSlashReviewRescheduleWorkItem(
          pool,
          item,
          latestHeadSha,
        );
        return {
          rescheduled: true,
          replacementWorkItemId,
          afterComplete: async (activeBoss, activePgBossJobId) => {
            await enqueueSlashReviewReschedule(
              pool,
              activeBoss,
              item,
              replacementWorkItemId,
              latestHeadSha,
              activePgBossJobId,
            );
          },
        };
      }
      const publishState = await getReviewPublishState(pool, item.id, item.resourceKey, reviewLens);
      const shouldLinkToSummary = await hasPriorCompletedSummaryPublish(
        pool,
        item.resourceKey,
        reviewLens,
        item.id,
      );
      const summaryCommentIdHint = shouldLinkToSummary
        ? await getSummaryCommentGithubId(pool, item.resourceKey, reviewLens)
        : null;
      const tokenState = { installation: env.installation };
      const headSha = env.headSha;
      let staleHeadAtPublish = false;
      const publishAbortState: { staleHead?: boolean } = {};

      const preflight = await fetchReviewPreflightMetadata(
        tokenState.installation.token,
        item.owner,
        item.repo,
        item.prNumber,
        { maxPrFilesListed: cfg.maxPrFilesListed },
      );
      const storedInlineFingerprints = await getStoredInlineFingerprints(
        pool,
        item.resourceKey,
        reviewLens,
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
        initReviewRunMetrics({
          provider: cfg.agentProvider,
          model: cfg.piModel,
          mode: reviewLens,
        });
        setReviewRunMetricFields({
          published: lightweightResult.published,
          publishAttempts: 0,
          lightweight: true,
        });
        logReviewRunCompleted();
        return { degraded: false };
      }

      return withPrRepositoryView(
        {
          cfg,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          installationToken: tokenState.installation.token,
        },
        async (repositoryView) => {
          const bot = await getAppBotIdentity(cfg);
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
            const latestHeadSha = await getPullRequestHeadSha(
              tokenState.installation.token,
              item.owner,
              item.repo,
              item.prNumber,
            );
            const replacementWorkItemId = await createSlashReviewRescheduleWorkItem(
              pool,
              item,
              latestHeadSha,
            );
            return {
              rescheduled: true,
              replacementWorkItemId,
              afterComplete: async (activeBoss, activePgBossJobId) => {
                await enqueueSlashReviewReschedule(
                  pool,
                  activeBoss,
                  item,
                  replacementWorkItemId,
                  latestHeadSha,
                  activePgBossJobId,
                );
              },
            };
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