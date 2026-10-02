import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.js";
import { productionInstallationSurface } from "../installationSurface.js";

import { AppError } from "../../errors/appError.js";
import { logInfo, logWarn } from "../../evlog.js";
import { warnReviewThreadResolutionDegraded } from "../../github/reviewThreadResolution.js";
import { loadRepoPolicy } from "../../review/repoPolicy.js";
import { fetchBotFindingThreads } from "../../review/run/reviewPriorFeedback.js";
import { runVerification } from "../../agent/verification/verificationRun.js";
import { publishVerification } from "../../agent/verification/publishVerification.js";
import {
  clearVerificationFailureSignal,
  publishVerificationFailure,
} from "../../agent/verification/publishVerificationFailure.js";
import {
  MAX_REPO_POLICY_BYTES,
  MAX_PR_FILES_LISTED,
  MAX_PR_FILES_PATCH_BYTES,
} from "../../settings/index.js";
import { listTriageEligibleInlineReviews } from "../publishRecordRepository.js";
import { type DurableExecutionResult } from "../durableJob.js";
import { escalatedVerificationInventory } from "../retryPolicy.js";

import {
  STALE_VERIFICATION_RESULT,
  verificationHeadFreshness,
  type VerificationDegradationReason,
} from "../verificationPublishGate.js";

export function createVerificationWorkExecution({
  cfg,
  pool,
  boss,
  installationSurface = productionInstallationSurface,
}: WorkExecutionDependencies): WorkExecution<"verification"> {
  const getBotIdentity = () => installationSurface.botIdentity(cfg);
  return {
    execute: async (item, env) => {
      const payload = item.payload;
      const { prSurface } = env;
      const headSha = env.headSha;
      const botIdentity = await getBotIdentity();

      const eligibleReviews = await listTriageEligibleInlineReviews(pool, item.resourceKey);
      const [threads, resolutionResult] = await Promise.all([
        fetchBotFindingThreads(prSurface, {
          botUserId: botIdentity.userId,
          publishRecordLenses: eligibleReviews,
          maintainerDecisionAssociations: cfg.associations.maintainerDecision,
        }),
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
      // Canonical oldest-first order, then the escalated subset. Prompt inventory,
      // submit validation, and publish must all see this exact one value.
      const orderedThreads = unresolvedThreads.toSorted(
        (a, b) => a.rootCommentId - b.rootCommentId,
      );

      const checkCompletionGate = async (): Promise<DurableExecutionResult | undefined> => {
        if (await env.shouldAbortPublish()) {
          logInfo("verification_publish_skipped", {
            type: "verification",
            workItemId: item.id,
            resourceKey: item.resourceKey,
            reason: "cancel_or_superseded",
            owner: item.owner,
            repo: item.repo,
            pr: item.prNumber,
          });
          return { kind: "completed" };
        }

        const freshness = verificationHeadFreshness(headSha, await prSurface.getHeadSha());
        if (freshness.kind === "stale") {
          logInfo("verification_publish_skipped", {
            type: "verification",
            workItemId: item.id,
            resourceKey: item.resourceKey,
            reason: "stale_head",
            boundHeadSha: freshness.boundHeadSha,
            latestHeadSha: freshness.latestHeadSha,
            owner: item.owner,
            repo: item.repo,
            pr: item.prNumber,
          });
          return STALE_VERIFICATION_RESULT;
        }
        return undefined;
      };

      if (orderedThreads.length === 0) {
        const terminal = await checkCompletionGate();
        if (terminal) return terminal;
        logInfo("verification_short_circuit_no_open_findings", {
          type: "verification",
          workItemId: item.id,
          resourceKey: item.resourceKey,
          threadCount: threads.length,
        });
        await clearVerificationFailureSignal({
          pool,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          prSurface,
          headSha,
          leaseEpoch: env.leaseEpoch,
          boss,
          installationId: item.installationId,
        });
        return { kind: "completed" };
      }

      await env.beginAttempt();
      const inventory = escalatedVerificationInventory(orderedThreads, env.escalation);
      const inventoryNarrowed = inventory.length < orderedThreads.length;
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
      // A manual run has no push delta, so an empty file set must not read as
      // "nothing changed": membership is unknown, not complete.
      const changedMembershipTruncated = compareFilesTruncated || payload.pushBeforeSha == null;
      const changedFilePaths =
        pushDeltaFiles != null
          ? compareFilesTruncated
            ? [...new Set([...pushDeltaFiles.files, ...prFiles.files.map((file) => file.filename)])]
            : pushDeltaFiles.files
          : [];

      if (compareFilesTruncated) {
        logWarn("verification_compare_files_truncated", {
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
          compareFileCount: pushDeltaFiles?.files.length ?? 0,
          effectiveChangedFileCount: changedFilePaths.length,
        });
      }

      const result = await env.withAdmittedRepositoryView(
        {
          repositorySizeKb: payload.repositorySizeKb,
          prFiles,
        },
        async (view) => {
          // Load policy while the checkout still exists; publish runs after the view closes.
          const policyResult = await loadRepoPolicy(view.workspace.agentCwd, MAX_REPO_POLICY_BYTES);
          const runResult = await runVerification({
            cfg,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            workspace: view.workspace,
            inventory,
            pushedCommits,
            compareFilesTruncated: changedMembershipTruncated,
            escalation: env.escalation,
            sessionContext: env.durability,
            signal: env.signal,
          });
          if (!runResult.submitted || !runResult.payload) {
            throw new AppError({
              domain: "verification",
              kind: "missing_submit",
              message: "Verification run ended without submitVerification",
            });
          }
          return { payload: runResult.payload, policyResult };
        },
      );

      const terminal = await checkCompletionGate();
      if (terminal) return terminal;

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
        inventory,
        resolutionByRootCommentId,
        payload: result.payload,
        changedFilePaths,
        changedFilePathsTruncated: changedMembershipTruncated,
        policyResult: result.policyResult,
        findingHistoryCfg: cfg,
        leaseEpoch: env.leaseEpoch,
      });
      await clearVerificationFailureSignal({
        pool,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        prSurface,
        headSha,
        leaseEpoch: env.leaseEpoch,
        boss,
        installationId: item.installationId,
      });

      const degradation = new Set<VerificationDegradationReason>(publish.degradation);
      if (resolutionDegraded) degradation.add("thread_resolution_degraded");
      if (compareFilesTruncated) degradation.add("compare_files_truncated");
      if (inventoryNarrowed) degradation.add("inventory_narrowed");
      const reasons = [...degradation];
      if (reasons.length > 0) {
        logWarn("verification_publish_degraded", {
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
          resolutionStatus: resolutionResult.status,
          degradation: reasons,
        });
        return {
          kind: "completed",
          degradation: reasons,
          completion: {
            kind: "verification",
            outcome: "degraded",
            inventoryNarrowed,
            durableDegradation: reasons[0],
          },
        };
      }
      return {
        kind: "completed",
        completion: { kind: "verification", outcome: "published", inventoryNarrowed },
      };
    },
    onTerminalFailure: async (item, prSurface, _error, leaseEpoch) => {
      if (!prSurface) return;
      await publishVerificationFailure({
        pool,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        prSurface,
        headSha: item.headSha,
        leaseEpoch: leaseEpoch ?? null,
        boss,
        installationId: item.installationId,
      });
    },
  };
}
