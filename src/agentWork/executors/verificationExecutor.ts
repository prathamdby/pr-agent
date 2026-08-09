import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { captureEvent } from "../../analytics/index.js";
import { AppError } from "../../errors/appError.js";
import {
  classifyFailure,
  classifiedFailureLogFields,
  classifiedFailurePostHogProperties,
} from "../../errors/classifiedFailure.js";
import { logInfo, logWarn } from "../../evlog.js";
import { getAppBotIdentity } from "../../github/appAuth.js";
import { warnReviewThreadResolutionDegraded } from "../../github/reviewThreadResolution.js";
import { loadRepoPolicy } from "../../review/repoPolicy.js";
import { runVerification } from "../../agent/verification/verificationRun.js";
import { publishVerification } from "../../agent/verification/publishVerification.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import {
  MAX_REPO_POLICY_BYTES,
  MAX_PR_FILES_LISTED,
  MAX_PR_FILES_PATCH_BYTES,
} from "../../settings/index.js";
import { listTriageEligibleInlineReviews, shouldSkipWork } from "../repository.js";
import { resolveWorkItemHead, runDurableWorkItem } from "../durableJob.js";
import { type VerificationJobData } from "../types.js";
import { buildRepositoryViewParams } from "./repositoryViewParams.js";

export async function executeVerificationJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<VerificationJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "verification",
    resolveHeadSha: resolveWorkItemHead,
    execute: async (item, env) => {
      const payload = item.payload;
      const { prSurface } = env;
      const headSha = env.headSha;
      const botIdentity = await getAppBotIdentity(cfg);

      const eligibleReviews = await listTriageEligibleInlineReviews(pool, item.resourceKey);
      const [threads, resolutionResult] = await Promise.all([
        prSurface.fetchBotFindingThreads(botIdentity.userId, eligibleReviews),
        prSurface.listInlineReviewThreads(),
      ]);

      warnReviewThreadResolutionDegraded(resolutionResult, {
        type: "verification",
        workItemId: item.id,
        resourceKey: item.resourceKey,
        owner: item.owner,
        repo: item.repo,
        pr: item.prNumber,
      });
      const resolutionByRootCommentId = resolutionResult.byRootCommentId;
      const resolutionDegraded = resolutionResult.status !== "ok";

      const unresolvedThreads = threads.filter(
        (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved !== true,
      );

      if (unresolvedThreads.length === 0) {
        logInfo("verification_short_circuit_no_open_findings", {
          type: "verification",
          workItemId: item.id,
          resourceKey: item.resourceKey,
          threadCount: threads.length,
        });
        return {};
      }

      const [prFiles, pushedCommits, pushDeltaFiles] = await Promise.all([
        prSurface.listChangedFiles(
          {
            maxPrFilesListed: MAX_PR_FILES_LISTED,
            maxPrFilesPatchBytes: MAX_PR_FILES_PATCH_BYTES,
          },
          env.pullRequest,
        ),
        prSurface.listPushedCommits(),
        payload.pushBeforeSha != null
          ? prSurface.listCommitCompareFiles(payload.pushBeforeSha, headSha)
          : Promise.resolve(null),
      ]);

      const compareFilesTruncated = pushDeltaFiles?.truncated === true;
      const changedFilePaths =
        pushDeltaFiles != null
          ? compareFilesTruncated
            ? [...new Set([...pushDeltaFiles.files, ...prFiles.files.map((file) => file.filename)])]
            : pushDeltaFiles.files
          : ([] as readonly string[]);

      if (compareFilesTruncated) {
        logWarn("verification_compare_files_truncated", {
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
          compareFileCount: pushDeltaFiles?.files.length ?? 0,
          effectiveChangedFileCount: changedFilePaths.length,
        });
      }

      const gitCredentialToken = await prSurface.gitCredentialToken();
      const result = await withPrRepositoryView(
        buildRepositoryViewParams(
          item,
          { installationToken: gitCredentialToken, headSha, pullRequest: env.pullRequest },
          payload,
          { prFiles },
        ),
        async (view) => {
          // Load policy while the checkout still exists; publish runs after the view closes.
          const policyResult = await loadRepoPolicy(view.agentCwd, MAX_REPO_POLICY_BYTES);
          const runResult = await runVerification({
            cfg,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            rootDir: view.agentCwd,
            inventory: unresolvedThreads,
            pushedCommits,
            compareFilesTruncated,
            durability: {
              pool,
              workItemId: item.id,
              installationId: item.installationId,
            },
          });
          if (!runResult.submitted || !runResult.payload) {
            throw new AppError({
              code: "verification.missing_submit",
              message: "Verification run ended without submitVerification",
            });
          }
          return { payload: runResult.payload, policyResult };
        },
      );

      if (await shouldSkipWork(pool, item)) {
        logInfo("verification_publish_skipped", {
          type: "verification",
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reason: "cancel_or_superseded",
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
        });
        return {};
      }

      const latestHeadSha = await prSurface.getHeadSha();
      if (latestHeadSha !== headSha) {
        logInfo("verification_publish_skipped", {
          type: "verification",
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reason: "stale_head",
          boundHeadSha: headSha,
          latestHeadSha,
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
        });
        return {};
      }

      const publish = await publishVerification({
        pool,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        installationId: item.installationId,
        prSurface,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha,
        inventory: unresolvedThreads,
        resolutionByRootCommentId,
        payload: result.payload,
        changedFilePaths,
        changedFilePathsTruncated: compareFilesTruncated,
        policyResult: result.policyResult,
        findingHistoryCfg: cfg,
        executionEpoch: env.executionEpoch,
      });

      const degraded = publish.degraded || resolutionDegraded || compareFilesTruncated;
      if (degraded) {
        const failure = classifyFailure(new Error("Verification publish degraded"), {
          phase: "publish",
        });
        logWarn("verification_publish_degraded", {
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
          resolutionStatus: resolutionResult.status,
          ...classifiedFailureLogFields(failure),
        });
        captureEvent({
          distinctId: `installation:${item.installationId}`,
          event: "verification failed",
          properties: {
            owner: item.owner,
            repo: item.repo,
            pr_number: item.prNumber,
            resolution_status: resolutionResult.status,
            ...classifiedFailurePostHogProperties(failure),
          },
        });
        return { degraded: true };
      }
      return {};
    },
  });
}
