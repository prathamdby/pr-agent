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
import { runHybridPrReview } from "../../review/run/hybridReviewRun.js";
import { runShadowReview, shouldSampleShadow } from "../../review/evaluation/reviewShadow.js";
import { resolveAgentRunnerProvider } from "../../agent/providers/index.js";
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
import {
  DESCRIPTION_AGENT_HEADER,
  MAX_REPO_POLICY_BYTES,
  REVIEW_SUMMARY_SENTINEL,
} from "../../settings/index.js";
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
  createReviewCheckpointStores,
} from "../repository.js";
import { buildStaleReviewRescheduleResult } from "../reviewReschedule.js";
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
    // Accept historical lens rows so cutover orphans cannot block unified /review.
    // execute() always runs as ReviewMode "review".
    acceptItem: (item) => item.reviewLens != null,
    resolveHeadSha: resolveWorkItemHead,
    execute: async (item, env) => {
      const reviewLens = "review" as const;
      const payload = item.payload as ReviewWorkPayload;
      initReviewRunMetrics({
        provider: cfg.agentProvider,
        model: cfg.piModel,
        mode: reviewLens,
      });
      if (!payload.staleHeadRescheduled && payload.staleHeadReplacementWorkItemId) {
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
        return buildStaleReviewRescheduleResult(
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

      const rescheduleForNewerHead = async () => {
        await completeCheckFromStoredSummary(
          "cancelled",
          "Review was rescheduled for a newer pull request head.",
        );
        return buildStaleReviewRescheduleResult(
          pool,
          item,
          tokenState.installation.token,
          tokenState.installation.expiresAtTs,
        );
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
        if (
          prefetchedPrFiles.headSha != null &&
          prefetchedPrFiles.headSha.toLowerCase() !== headSha.toLowerCase() &&
          !payload.staleHeadRescheduled &&
          !(await shouldSkipWork(pool, item))
        ) {
          return rescheduleForNewerHead();
        }
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
          deriveAuthoritativeChangeSet: cfg.reviewPipelineMode !== "legacy",
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
              changedFiles: repositoryView.preflight.files.map((file) => file.filename),
            });
            repoPolicyBlock = rendered || undefined;
          }

          const { trustedContext, sizeBudget } = buildTrustedReviewContextForReview({
            preflight: repositoryView.preflight,
            priorInlineFeedback: priorInlineFeedbackResult.value,
            repoPolicyBlock,
          });

          const runParams = {
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
            budgetTier: sizeBudget.tier,
            selectedReviewerIds: sizeBudget.selectedReviewerIds,
            omittedReviewerIds: sizeBudget.omittedReviewerIds,
            severityFloor,
            storedInlineFingerprints,
            cwd: repositoryView.agentCwd,
            workspace: repositoryView.workspace,
            prFiles: repositoryView.prFiles,
            shouldLinkToSummary,
            summaryCommentIdHint,
            hasDescriptionAgentBlock: (
              (env.pullRequest as { body?: string | null } | undefined)?.body ?? ""
            ).includes(DESCRIPTION_AGENT_HEADER),
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
          };

          const result =
            cfg.reviewPipelineMode === "hybrid"
              ? await runHybridPrReview({
                  ...runParams,
                  hybrid: {
                    workItemId: item.id,
                    ...createReviewCheckpointStores(pool),
                  },
                })
              : await runFullPrReview(runParams);
          if (
            staleHeadAtPublish &&
            !payload.staleHeadRescheduled &&
            !(await shouldSkipWork(pool, item))
          ) {
            return rescheduleForNewerHead();
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

          if (
            cfg.reviewPipelineMode === "shadow" &&
            shouldSampleShadow({
              sampleRate: cfg.reviewShadowSampleRate,
              workItemId: item.id,
              headSha,
            })
          ) {
            try {
              const shadowResult = await runShadowReview({
                cfg,
                runner: resolveAgentRunnerProvider(cfg),
                cwd: repositoryView.agentCwd,
                owner: item.owner,
                repo: item.repo,
                prNumber: item.prNumber,
                headSha,
                userSupplement: payload.userSupplement,
                trustedContext,
                workspace: repositoryView.workspace,
                prFiles: repositoryView.prFiles,
              });
              logInfo("review_shadow_paired", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                headSha,
                legacy_published: result.published,
                shadow_findings_count: shadowResult.findings.length,
                shadow_degraded: shadowResult.degraded,
                shadow_duration_ms: shadowResult.durationMs,
              });
            } catch (error) {
              logWarn("review_shadow_failed", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                headSha,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }

          return { degraded: !result.published && !result.publishSuperseded };
        },
      );
    },
    onCancelled: async (item, installation) => {
      if (item.reviewLens == null) return;
      const reviewLens = "review" as const;
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
      const reviewLens = "review" as const;
      const summary = await upsertReviewSummaryComment(
        installation.token,
        item.owner,
        item.repo,
        item.prNumber,
        renderReviewFailureNotice({
          retryCommand: "/review",
        }),
        REVIEW_SUMMARY_SENTINEL,
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
