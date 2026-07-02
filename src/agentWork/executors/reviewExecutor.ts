import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { posthog } from "../../posthog.js";
import {
  assertPullRequestFilesHeadSha,
  fetchPullRequestFiles,
  type ListPullRequestFilesResult,
} from "../../github/listPullRequestFiles.js";
import { runFullPrReview } from "../../review/run/reviewRun.js";
import {
  loadRepoPolicy,
  logInvalidRepoPolicy,
  renderRepoPolicyBlock,
} from "../../review/repoPolicy.js";
import {
  buildTrustedReviewContextForReview,
  fetchPriorInlineFeedbackBlockForReview,
} from "../../review/prompts/reviewTrustedContext.js";
import { buildReviewPreflightMetadataFromPullRequestFiles } from "../../review/placement/reviewPreflightFiles.js";
import {
  reviewRetrySlashCommandForMode,
  reviewSummarySentinelForMode,
} from "../../review/reviewSchema.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordReviewPhaseSpan,
  setReviewRunMetricFields,
  snapshotReviewRunMetrics,
} from "../../review/run/reviewRunMetrics.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { logInfo, logWarn } from "../../evlog.js";
import { attachSummaryCommentCoordination } from "../../review/publish/publishReview.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { MAX_REPO_POLICY_BYTES } from "../../settings/index.js";
import { tryLightweightAutoReviewCompletion } from "../reviewLightweightCompletion.js";
import {
  completeReviewCheckRun,
  ensureReviewCheckRunStarted,
  reviewCheckDetailsUrl,
} from "../reviewCheckRun.js";
import {
  loadReviewExecutorPublishContext,
  getSummaryCommentGithubId,
  recordPublishStep,
  shouldSkipWork,
} from "../repository.js";
import { buildStaleSlashReviewRescheduleResult } from "../reviewReschedule.js";
import { renderReviewFailureNotice } from "../../review/run/progressComment.js";
import {
  makeInstallationTokenRefresher,
  resolveWorkItemHead,
  runDurableWorkItem,
} from "../durableJob.js";
import { getAppBotIdentity, getPullRequestHeadSha } from "../githubPrSurface.js";
import { type ReviewJobData, type ReviewWorkPayload } from "../types.js";

type SettledPriorInlineFeedback =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly error: unknown };

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
    resolveHeadSha: resolveWorkItemHead,
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
        await completeReviewCheckRun(pool, {
          cfg,
          token: env.installation.token,
          tokenExpiresAtTs: env.installation.expiresAtTs,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens,
          conclusion: "cancelled",
          summary: "Review was rescheduled for a newer pull request head.",
        });
        return buildStaleSlashReviewRescheduleResult(
          pool,
          item,
          env.installation.token,
          env.installation.expiresAtTs,
        );
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
      let prefetchedPrFiles: ListPullRequestFilesResult | undefined;

      await ensureReviewCheckRunStarted(pool, {
        cfg,
        token: tokenState.installation.token,
        tokenExpiresAtTs: tokenState.installation.expiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
      });

      const completeCheckFromStoredSummary = async (
        conclusion: "failure" | "cancelled",
        summary: string,
      ) => {
        const summaryCommentId = await getSummaryCommentGithubId(
          pool,
          item.resourceKey,
          reviewLens,
        );
        await completeReviewCheckRun(pool, {
          cfg,
          token: tokenState.installation.token,
          tokenExpiresAtTs: tokenState.installation.expiresAtTs,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens,
          conclusion,
          summary,
          detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summaryCommentId),
        });
      };

      if (payload.source === "auto") {
        prefetchedPrFiles = await recordReviewPhaseSpan("preflight", () =>
          fetchPullRequestFiles(
            tokenState.installation.token,
            item.owner,
            item.repo,
            item.prNumber,
            {
              maxPrFilesListed: cfg.maxPrFilesListed,
              maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
            },
            undefined,
            tokenState.installation.expiresAtTs,
          ),
        );
        assertPullRequestFilesHeadSha(prefetchedPrFiles, headSha);
        const preflight = buildReviewPreflightMetadataFromPullRequestFiles(prefetchedPrFiles);
        const lightweightResult = await tryLightweightAutoReviewCompletion(pool, {
          item,
          reviewLens,
          token: tokenState.installation.token,
          tokenExpiresAtTs: tokenState.installation.expiresAtTs,
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
          await completeReviewCheckRun(pool, {
            cfg,
            token: tokenState.installation.token,
            tokenExpiresAtTs: tokenState.installation.expiresAtTs,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            workItemId: item.id,
            resourceKey: item.resourceKey,
            reviewLens,
            conclusion: lightweightResult.published ? "success" : "cancelled",
            summary: lightweightResult.published
              ? "Documentation-only change set."
              : "Review was cancelled before lightweight completion.",
            detailsUrl: reviewCheckDetailsUrl(
              item.owner,
              item.repo,
              item.prNumber,
              lightweightResult.published ? lightweightResult.summaryId : null,
            ),
          });
          return { degraded: false };
        }
      }

      const logPriorFeedbackError = (error: unknown) => {
        logWarn("prior_inline_feedback_fetch_failed", {
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
          reviewLens,
          message: error instanceof Error ? error.message : String(error),
        });
      };
      const priorInlineFeedback: Promise<SettledPriorInlineFeedback> = getAppBotIdentity(cfg)
        .catch((error: unknown) => {
          logPriorFeedbackError(error);
          throw error;
        })
        .then((bot) =>
          fetchPriorInlineFeedbackBlockForReview({
            token: tokenState.installation.token,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            reviewLens,
            botUserId: bot.userId,
            onPriorFeedbackError: logPriorFeedbackError,
          }),
        )
        .then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
      return withPrRepositoryView(
        {
          cfg,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          installationToken: tokenState.installation.token,
          installationExpiresAtTs: tokenState.installation.expiresAtTs,
          prFiles: prefetchedPrFiles,
          pullRequest: env.pullRequest,
          repositorySizeKb: payload.repositorySizeKb,
        },
        async (repositoryView) => {
          const priorInlineFeedbackResult = await priorInlineFeedback;
          if (!priorInlineFeedbackResult.ok) throw priorInlineFeedbackResult.error;

          const policyResult = await loadRepoPolicy(repositoryView.agentCwd, MAX_REPO_POLICY_BYTES);
          let repoPolicyBlock: string | undefined;
          let severityFloor: number | undefined;
          if (policyResult.kind === "invalid") {
            logInvalidRepoPolicy(repositoryView.agentCwd, policyResult.reason);
          } else if (policyResult.kind === "ok") {
            severityFloor = policyResult.policy.severityFloor;
            const rendered = renderRepoPolicyBlock({
              policy: policyResult.policy,
              mode: reviewLens,
              changedFiles: repositoryView.preflight.files.map((file) => file.filename),
            });
            repoPolicyBlock = rendered || undefined;
          }

          const trustedContext = buildTrustedReviewContextForReview({
            preflight: repositoryView.preflight,
            priorInlineFeedback: priorInlineFeedbackResult.value,
            repoPolicyBlock,
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
            severityFloor,
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
            recordPublishStep: attachSummaryCommentCoordination(
              (step, detail) =>
                recordPublishStep(pool, {
                  workItemId: item.id,
                  resourceKey: item.resourceKey,
                  reviewLens,
                  step,
                  githubId: detail?.githubId,
                  detail: detail?.meta,
                }),
              { pool, workItemId: item.id, resourceKey: item.resourceKey },
            ),
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
                tokenState.installation.expiresAtTs,
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
            await completeCheckFromStoredSummary(
              "cancelled",
              "Review was rescheduled for a newer pull request head.",
            );
            return buildStaleSlashReviewRescheduleResult(
              pool,
              item,
              tokenState.installation.token,
              tokenState.installation.expiresAtTs,
            );
          }
          if (!result.published) {
            if (result.publishSuperseded) {
              logInfo("review_publish_superseded", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                publishAttempts: result.publishAttempts,
              });
              await completeCheckFromStoredSummary(
                "cancelled",
                "Review publish was skipped because the work was superseded or cancelled.",
              );
            } else {
              logWarn("review_not_published", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                publishAttempts: result.publishAttempts,
                publishDegraded: true,
              });
              posthog.capture({
                distinctId: `installation:${item.installationId}`,
                event: "review failed",
                properties: {
                  owner: item.owner,
                  repo: item.repo,
                  pr_number: item.prNumber,
                  review_lens: reviewLens,
                  publish_attempts: result.publishAttempts,
                },
              });
              await completeCheckFromStoredSummary(
                "failure",
                "PR Agent could not publish a structured review.",
              );
            }
          } else {
            const snapshot = snapshotReviewRunMetrics();
            posthog.capture({
              distinctId: `installation:${item.installationId}`,
              event: "review published",
              properties: {
                owner: item.owner,
                repo: item.repo,
                pr_number: item.prNumber,
                review_lens: reviewLens,
                findings_count: snapshot?.findingsCount ?? 0,
                severities: snapshot?.severities ?? [],
                provider: cfg.agentProvider,
                model: cfg.piModel,
                publish_attempts: result.publishAttempts,
                wall_clock_ms: snapshot?.wallClockMs,
                source: payload.source,
              },
            });
          }
          return { degraded: !result.published && !result.publishSuperseded };
        },
      );
    },
    onCancelled: async (item, installation) => {
      if (!item.reviewLens) return;
      const reviewLens = item.reviewLens;
      const summaryCommentId = await getSummaryCommentGithubId(pool, item.resourceKey, reviewLens);
      await completeReviewCheckRun(pool, {
        cfg,
        token: installation.token,
        tokenExpiresAtTs: installation.expiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        conclusion: "cancelled",
        summary: "Review was cancelled before completion.",
        detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summaryCommentId),
      });
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation) return;
      const reviewLens = item.reviewLens!;
      const summary = await upsertReviewSummaryComment(
        installation.token,
        item.owner,
        item.repo,
        item.prNumber,
        renderReviewFailureNotice({
          mode: reviewLens,
          retryCommand: reviewRetrySlashCommandForMode(reviewLens),
        }),
        reviewSummarySentinelForMode(reviewLens),
        undefined,
        installation.expiresAtTs,
      );
      await completeReviewCheckRun(pool, {
        cfg,
        token: installation.token,
        tokenExpiresAtTs: installation.expiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        conclusion: "failure",
        summary: "PR Agent could not complete the review after retries.",
        detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summary.id),
      });
    },
  });
}
