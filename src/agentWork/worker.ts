import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import type { JobWithMetadata, Job, PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { runAskRun } from "../agent/askRun.js";
import { formatAskFailureReply, sanitizeAskAnswerText } from "../agent/formatAskReply.js";
import { runFullPrReview } from "../agent/reviewRun.js";
import { buildTrustedReviewContextBlock } from "../agent/reviewTrustedContext.js";
import { reviewSummarySentinelForMode } from "../agent/reviewSchema.js";
import { tryLightweightAutoReviewCompletion } from "./reviewLightweightCompletion.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  setReviewRunMetricFields,
} from "../agent/reviewRunMetrics.js";
import { getAppBotIdentity, installationOctokit } from "../github/appAuth.js";
import { upsertReviewSummaryComment } from "../github/reviewPublish.js";
import { logDebug, logInfo, logWarn, runWithOperationLogger } from "../evlog.js";
import {
  getReviewPublishState,
  getStoredInlineFingerprints,
  getSummaryCommentGithubId,
  getWorkItem,
  hasPriorCompletedSummaryPublish,
  recordPublishStep,
  shouldSkipWork,
} from "./repository.js";
import { mintInstallationToken, runDurableWorkItem } from "./durableJob.js";
import {
  createSlashReviewRescheduleWorkItem,
  enqueueSlashReviewReschedule,
} from "./reviewReschedule.js";
import { preparePrRepositoryView } from "./prRepositoryView.js";
import { cleanupStaleLocalPrWorkspaces } from "./localPrWorkspace.js";
import { GITHUB_REACTION_EYES } from "../settings/index.js";
import { renderReviewFailureNotice, renderReviewProgressComment } from "./progressComment.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  REVIEW_QUEUE,
  type AckJobData,
  type AckTarget,
  type AgentWorkItem,
  type AskWorkPayload,
  type AskJobData,
  type ReviewJobData,
  type ReviewWorkPayload,
  DEFERRED_HEAD_SHA,
} from "./types.js";

function workerJobMeta(
  queue: string,
  data: { workItemId?: string; webhookEventId?: string; delivery?: string },
  pgBossJobId?: string,
) {
  return {
    method: "JOB",
    path: `/queues/${queue}`,
    requestId: data.delivery ?? data.workItemId ?? pgBossJobId,
    context: {
      role: "worker",
      queue,
      workItemId: data.workItemId,
      webhookEventId: data.webhookEventId,
      delivery: data.delivery,
      pgBossJobId,
    },
  };
}

async function getPullRequestHeadSha(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const octokit = installationOctokit(token);
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return data.head.sha;
}

async function safeReaction(
  token: string,
  owner: string,
  repo: string,
  target: AckTarget,
): Promise<void> {
  const octokit = installationOctokit(token);
  try {
    if (target.kind === "pr") {
      await octokit.rest.reactions.createForIssue({
        owner,
        repo,
        issue_number: target.prNumber,
        content: GITHUB_REACTION_EYES,
      });
    } else if (target.kind === "issueComment") {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: target.commentId,
        content: GITHUB_REACTION_EYES,
      });
    } else {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: target.commentId,
        content: GITHUB_REACTION_EYES,
      });
    }
  } catch (e: unknown) {
    const status = (e as { status?: number }).status;
    if (status === 422 || status === 403) return;
    throw e;
  }
}

async function postReply(token: string, data: AckJobData, body: string): Promise<void> {
  const target = data.reply?.target;
  if (!target) return;
  const octokit = installationOctokit(token);
  if (target.kind === "inlineReviewThread") {
    await octokit.rest.pulls.createReplyForReviewComment({
      owner: data.owner,
      repo: data.repo,
      pull_number: target.prNumber,
      comment_id: target.inReplyToCommentId,
      body,
    });
    return;
  }
  await octokit.rest.issues.createComment({
    owner: data.owner,
    repo: data.repo,
    issue_number: target.prNumber,
    body,
  });
}

async function handleAckJob(cfg: Config, pool: Pool, data: AckJobData): Promise<void> {
  if (data.commenterId != null) {
    try {
      const bot = await getAppBotIdentity(cfg);
      if (bot.userId === data.commenterId) return;
    } catch (e) {
      logWarn("ack_bot_identity_check_failed", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const installation = await mintInstallationToken(cfg, data.installationId);

  for (const target of data.targets) {
    try {
      await safeReaction(installation.token, data.owner, data.repo, target);
    } catch (e) {
      logDebug("ack_reaction_failed", {
        owner: data.owner,
        repo: data.repo,
        targetKind: target.kind,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (data.progress) {
    const headSha =
      data.progress.headSha === DEFERRED_HEAD_SHA
        ? await getPullRequestHeadSha(installation.token, data.owner, data.repo, data.prNumber)
        : data.progress.headSha;
    const body = renderReviewProgressComment({
      mode: data.progress.lens,
      headSha,
      source: data.progress.source,
    });
    const summary = await upsertReviewSummaryComment(
      installation.token,
      data.owner,
      data.repo,
      data.prNumber,
      body,
      reviewSummarySentinelForMode(data.progress.lens),
    );
    if (data.workItemId) {
      await recordPublishStep(pool, {
        workItemId: data.workItemId,
        resourceKey: `${data.owner}/${data.repo}#${data.prNumber}`,
        reviewLens: data.progress.lens,
        step: "progress_comment",
        githubId: summary.id,
        detail: { updated: summary.updated },
      });
    }
  }

  if (data.reply) {
    await postReply(installation.token, data, data.reply.body);
  }
}

async function handleReviewJob(
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
    resolveHeadSha: (token, item) =>
      item.headSha === DEFERRED_HEAD_SHA
        ? getPullRequestHeadSha(token, item.owner, item.repo, item.prNumber)
        : Promise.resolve(item.headSha),
    execute: async (item, env) => {
      const reviewLens = item.reviewLens!;
      const payload = item.payload as ReviewWorkPayload;
      if (
        payload.source === "slash" &&
        !payload.staleHeadRescheduled &&
        payload.staleHeadReplacementWorkItemId
      ) {
        const replacementWorkItemId = payload.staleHeadReplacementWorkItemId;
        const replacement = await getWorkItem(pool, replacementWorkItemId);
        const latestHeadSha =
          replacement?.headSha ??
          (await getPullRequestHeadSha(
            env.installation.token,
            item.owner,
            item.repo,
            item.prNumber,
          ));
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
      let installation = env.installation;
      const headSha = env.headSha;
      let staleHeadAtPublish = false;
      const publishAbortState: { staleHead?: boolean } = {};

      const repositoryView = await preparePrRepositoryView({
        cfg,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha,
        installationToken: installation.token,
      });
      try {
        const preflight = repositoryView.preflight;
        const storedInlineFingerprints = await getStoredInlineFingerprints(
          pool,
          item.resourceKey,
          reviewLens,
        );
        const trustedContext = buildTrustedReviewContextBlock(preflight);

        const lightweightResult = await tryLightweightAutoReviewCompletion(pool, {
          item,
          reviewLens,
          token: installation.token,
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

        const result = await runFullPrReview({
          cfg,
          token: installation.token,
          tokenExpiresAtTs: installation.expiresAtTs,
          tokenTtlMs: installation.ttlMs,
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
              installation.token,
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
          refreshInstallationToken: async () => {
            const fresh = await mintInstallationToken(cfg, item.installationId);
            installation = fresh;
            return { token: fresh.token, expiresAtTs: fresh.expiresAtTs };
          },
        });
        if (staleHeadAtPublish && payload.source === "slash" && !payload.staleHeadRescheduled) {
          const latestHeadSha = await getPullRequestHeadSha(
            installation.token,
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
          logWarn("review_not_published", {
            owner: item.owner,
            repo: item.repo,
            pr: item.prNumber,
            publishAttempts: result.publishAttempts,
            publishDegraded: true,
          });
        }
        return { degraded: !result.published };
      } finally {
        await repositoryView.cleanup();
      }
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
          retryCommand: reviewLens === "review-security" ? "/review-security" : "/review",
        }),
        reviewSummarySentinelForMode(reviewLens),
      );
    },
  });
}

async function publishAskAnswer(token: string, item: AgentWorkItem, answer: string): Promise<void> {
  const body = sanitizeAskAnswerText(answer);
  const replyTarget = (item.payload as AskWorkPayload).replyTarget;
  const octokit = installationOctokit(token);
  if (replyTarget.kind === "inlineReviewThread") {
    try {
      await octokit.rest.pulls.createReplyForReviewComment({
        owner: item.owner,
        repo: item.repo,
        pull_number: replyTarget.prNumber,
        comment_id: replyTarget.inReplyToCommentId,
        body,
      });
      return;
    } catch (e) {
      logWarn("ask_inline_reply_failed", {
        owner: item.owner,
        repo: item.repo,
        pr: replyTarget.prNumber,
        inReplyToCommentId: replyTarget.inReplyToCommentId,
        message: e instanceof Error ? e.message : String(e),
      });
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
  await octokit.rest.issues.createComment({
    owner: item.owner,
    repo: item.repo,
    issue_number: replyTarget.prNumber,
    body,
  });
}

async function handleAskJob(
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
      let installation = env.installation;
      const headSha = env.headSha;
      const payload = item.payload as AskWorkPayload;
      const repositoryView = await preparePrRepositoryView({
        cfg,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha,
        installationToken: installation.token,
      });
      try {
        const result = await runAskRun({
          cfg,
          token: installation.token,
          tokenExpiresAtTs: installation.expiresAtTs,
          tokenTtlMs: installation.ttlMs,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          question: payload.question,
          replyTarget: payload.replyTarget,
          codeAnchor: payload.codeAnchor,
          cwd: repositoryView.agentCwd,
          workspace: repositoryView.workspace,
          refreshInstallationToken: async () => {
            const fresh = await mintInstallationToken(cfg, item.installationId);
            installation = fresh;
            return { token: fresh.token, expiresAtTs: fresh.expiresAtTs };
          },
        });
        await publishAskAnswer(installation.token, item, result.answer);
        return {};
      } finally {
        await repositoryView.cleanup();
      }
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
      );
    },
  });
}

function registerPlainQueue<T>(
  boss: PgBoss,
  queue: string,
  options: Parameters<PgBoss["work"]>[1],
  dispatch: (job: Job<T>) => Promise<void>,
): Promise<unknown> {
  return boss.work<T>(queue, options, async ([job]) => {
    await runWithOperationLogger(workerJobMeta(queue, job.data as never, job.id), () =>
      dispatch(job),
    );
  });
}

function registerMetadataQueue<T>(
  boss: PgBoss,
  queue: string,
  options: Omit<Parameters<PgBoss["work"]>[1], "includeMetadata">,
  dispatch: (job: JobWithMetadata<T>) => Promise<void>,
): Promise<unknown> {
  return boss.work<T>(queue, { ...options, includeMetadata: true }, async ([job]) => {
    await runWithOperationLogger(workerJobMeta(queue, job.data as never, job.id), () =>
      dispatch(job),
    );
  });
}

export const AgentWorkerLive = (cfg: Config, pool: Pool, boss: PgBoss) =>
  Layer.scopedDiscard(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const heartbeatRefresh = Math.max(1, Math.floor(cfg.queueHeartbeatSeconds / 2));
          const durableQueueOptions = {
            groupConcurrency: cfg.installationGroupConcurrency,
            heartbeatRefreshSeconds: heartbeatRefresh,
          };
          await cleanupStaleLocalPrWorkspaces(cfg);
          await Promise.all([
            registerPlainQueue<AckJobData>(
              boss,
              ACK_QUEUE,
              { localConcurrency: cfg.ackConcurrency },
              (job) => handleAckJob(cfg, pool, job.data),
            ),
            registerMetadataQueue<ReviewJobData>(
              boss,
              REVIEW_QUEUE,
              { localConcurrency: cfg.reviewConcurrency, ...durableQueueOptions },
              (job) => handleReviewJob(cfg, pool, boss, job),
            ),
            registerMetadataQueue<AskJobData>(
              boss,
              ASK_QUEUE,
              { localConcurrency: cfg.askConcurrency, ...durableQueueOptions },
              (job) => handleAskJob(cfg, pool, boss, job),
            ),
          ]);
          logInfo("agent_worker_started", {
            queues: [ACK_QUEUE, REVIEW_QUEUE, ASK_QUEUE],
            reviewConcurrency: cfg.reviewConcurrency,
            askConcurrency: cfg.askConcurrency,
            ackConcurrency: cfg.ackConcurrency,
          });
          for (const queue of [ACK_QUEUE, REVIEW_QUEUE, ASK_QUEUE]) {
            const stats = await boss.getQueueStats(queue);
            logDebug("agent_queue_stats", {
              queue,
              queued: stats.queuedCount,
              active: stats.activeCount,
              total: stats.totalCount,
            });
          }
          const blockedReviewKeys = await boss.getBlockedKeys(REVIEW_QUEUE);
          if (blockedReviewKeys.length > 0) {
            logWarn("agent_review_queue_blocked_keys", { keys: blockedReviewKeys });
          }
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
      () =>
        Effect.tryPromise({
          try: async () => {
            await Promise.all([ACK_QUEUE, REVIEW_QUEUE, ASK_QUEUE].map((q) => boss.offWork(q)));
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.orDie),
    ).pipe(Effect.zipRight(Effect.never)),
  );
