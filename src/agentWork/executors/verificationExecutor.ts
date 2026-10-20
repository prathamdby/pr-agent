import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.ts";
import { productionInstallationSurface } from "../installationSurface.ts";

import { AppError } from "../../errors/appError.ts";
import { logInfo, logWarn } from "../../evlog.ts";
import { warnReviewThreadResolutionDegraded } from "../../github/reviewThreadResolution.ts";
import { loadFindingInventoryFromThreads } from "../../review/findingIdentity/findingInventory.ts";
import { loadRepoPolicy } from "../../review/repoPolicy.ts";
import { reviewRecoveryBaseSha } from "../../review/recovery/reviewRecoveryBinding.ts";
import {
  fetchBotFindingThreads,
  type BotFindingThread,
  type FindingObjection,
} from "../../review/run/reviewPriorFeedback.ts";
import { runVerification } from "../../agent/verification/verificationRun.ts";
import { publishVerification } from "../../agent/verification/publishVerification.ts";
import {
  clearVerificationFailureSignal,
  publishVerificationFailure,
} from "../../agent/verification/publishVerificationFailure.ts";
import {
  MAX_REPO_POLICY_BYTES,
  MAX_PR_FILES_LISTED,
  MAX_PR_FILES_PATCH_BYTES,
  VERIFICATION_MAX_OBJECTION_ANSWERS_PER_RUN,
} from "../../settings/index.ts";
import { throwIfExecutionAborted } from "../publishOnce.ts";
import { listTriageEligibleInlineReviews } from "../publishRecordRepository.ts";
import { type DurableExecutionResult } from "../durableJob.ts";
import { escalatedVerificationInventory } from "../retryPolicy.ts";
import {
  loadVerificationThreadLedger,
  type VerificationThreadLedger,
} from "../verificationThreadLedger.ts";

import {
  STALE_VERIFICATION_RESULT,
  verificationHeadFreshness,
  type VerificationDegradationReason,
} from "../verificationPublishGate.ts";

function withoutFindingObjections(thread: BotFindingThread): BotFindingThread {
  return {
    rootCommentId: thread.rootCommentId,
    ...(thread.findingId !== undefined ? { findingId: thread.findingId } : {}),
    lens: thread.lens,
    path: thread.path,
    line: thread.line,
    severity: thread.severity,
    titleSnippet: thread.titleSnippet,
    humanReplies: thread.humanReplies,
    ...(thread.authorizedReplies !== undefined
      ? { authorizedReplies: thread.authorizedReplies }
      : {}),
    ...(thread.untrustedReplies !== undefined ? { untrustedReplies: thread.untrustedReplies } : {}),
    ...(thread.replies !== undefined ? { replies: thread.replies } : {}),
    ...(thread.hasTriageReply !== undefined ? { hasTriageReply: thread.hasTriageReply } : {}),
    ...(thread.verificationStubCommentId !== undefined
      ? { verificationStubCommentId: thread.verificationStubCommentId }
      : {}),
    threadUrl: thread.threadUrl,
  };
}

function withPresentedObjections(
  thread: BotFindingThread,
  objections: readonly FindingObjection[],
): BotFindingThread {
  if (objections.length === 0) return withoutFindingObjections(thread);
  return { ...thread, objections };
}

function objectionCount(threads: readonly BotFindingThread[]): number {
  return threads.reduce((sum, thread) => sum + (thread.objections?.length ?? 0), 0);
}

function dropJournaledNonObjections(
  threads: readonly BotFindingThread[],
  ledger: VerificationThreadLedger,
): readonly BotFindingThread[] {
  return threads.map((thread) => {
    const hidden = new Set(
      (ledger.threads[String(thread.rootCommentId)]?.objections ?? [])
        .filter((entry) => entry.decision === "not_objection")
        .map((entry) => `${entry.commentId}:${entry.updatedAt}`),
    );
    if (hidden.size === 0 || thread.objections == null) return thread;
    return withPresentedObjections(
      thread,
      thread.objections.filter(
        (objection) => !hidden.has(`${objection.commentId}:${objection.updatedAt}`),
      ),
    );
  });
}

function capObjectionAnswers(threads: readonly BotFindingThread[]): {
  readonly threads: readonly BotFindingThread[];
  readonly deferred: number;
} {
  const ranked = threads
    .flatMap((thread) => thread.objections ?? [])
    .toSorted((left, right) => {
      const created = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return created === 0 ? left.commentId - right.commentId : created;
    });
  if (ranked.length <= VERIFICATION_MAX_OBJECTION_ANSWERS_PER_RUN) {
    return { threads, deferred: 0 };
  }
  const kept = new Set(
    ranked
      .slice(0, VERIFICATION_MAX_OBJECTION_ANSWERS_PER_RUN)
      .map((objection) => objection.commentId),
  );
  return {
    deferred: ranked.length - VERIFICATION_MAX_OBJECTION_ANSWERS_PER_RUN,
    threads: threads.map((thread) =>
      thread.objections == null
        ? thread
        : withPresentedObjections(
            thread,
            thread.objections.filter((objection) => kept.has(objection.commentId)),
          ),
    ),
  };
}

function objectionCompletionFields(counts: {
  readonly presented: number;
  readonly answered: number;
  readonly notObjection: number;
  readonly deferred: number;
  readonly skippedIncomplete: number;
}): {
  readonly objectionsPresented?: number;
  readonly objectionsAnswered?: number;
  readonly objectionsNotObjection?: number;
  readonly objectionsDeferredByCap?: number;
  readonly objectionsSkippedIncomplete?: number;
} {
  return {
    ...(counts.presented > 0 ? { objectionsPresented: counts.presented } : {}),
    ...(counts.answered > 0 ? { objectionsAnswered: counts.answered } : {}),
    ...(counts.notObjection > 0 ? { objectionsNotObjection: counts.notObjection } : {}),
    ...(counts.deferred > 0 ? { objectionsDeferredByCap: counts.deferred } : {}),
    ...(counts.skippedIncomplete > 0
      ? { objectionsSkippedIncomplete: counts.skippedIncomplete }
      : {}),
  };
}

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
      const resolutionResult = await prSurface.listInlineReviewThreads();
      const findingInventory = await loadFindingInventoryFromThreads(prSurface, {
        threads: resolutionResult,
        botLogin: botIdentity.login,
        renames: new Map(),
        deletedPaths: new Set(),
      });
      const listedThreads = await fetchBotFindingThreads(prSurface, {
        botUserId: botIdentity.userId,
        botLogin: botIdentity.login,
        inventory: findingInventory,
        publishRecordLenses: eligibleReviews,
        maintainerDecisionAssociations: cfg.associations.maintainerDecision,
      });
      const threads = listedThreads.threads;
      const reviewCommentsTruncated = listedThreads.reviewCommentsTruncated;

      warnReviewThreadResolutionDegraded(resolutionResult, {
        type: "verification",
        workItemId: item.id,
        resourceKey: item.resourceKey,
        owner: item.owner,
        repo: item.repo,
        pr: item.prNumber,
      });
      const resolutionByRootCommentId = resolutionResult.byRootCommentId;
      const resolutionDegraded = findingInventory.completeness !== "complete";

      const unresolvedThreads = threads.filter(
        (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved !== true,
      );
      let orderedThreads = unresolvedThreads.toSorted((a, b) => a.rootCommentId - b.rootCommentId);
      let objectionsSkippedIncomplete = 0;
      if (reviewCommentsTruncated) {
        objectionsSkippedIncomplete = objectionCount(orderedThreads);
        orderedThreads = orderedThreads.map(withoutFindingObjections);
      } else if (objectionCount(orderedThreads) > 0) {
        const ledger = await loadVerificationThreadLedger(pool, {
          resourceKey: item.resourceKey,
        });
        orderedThreads = [...dropJournaledNonObjections(orderedThreads, ledger)];
      }

      const checkCompletionGate = async (): Promise<DurableExecutionResult | undefined> => {
        throwIfExecutionAborted(env.signal, { workItemId: item.id });
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
      const escalated = escalatedVerificationInventory(orderedThreads, env.escalation);
      const inventoryNarrowed = escalated.length < orderedThreads.length;
      const capped = capObjectionAnswers(escalated);
      const inventory = capped.threads;
      if (capped.deferred > 0) {
        logInfo("verification_objections_deferred", {
          workItemId: item.id,
          resourceKey: item.resourceKey,
          deferred: capped.deferred,
        });
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

      const resolvedHead = await prSurface.getHead();
      const preViewFreshness = verificationHeadFreshness(headSha, resolvedHead.headSha);
      if (preViewFreshness.kind === "stale") {
        logInfo("verification_publish_skipped", {
          type: "verification",
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reason: "stale_head",
          boundHeadSha: preViewFreshness.boundHeadSha,
          latestHeadSha: preViewFreshness.latestHeadSha,
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
        });
        return STALE_VERIFICATION_RESULT;
      }
      const baseSha = reviewRecoveryBaseSha(resolvedHead.pullRequest);
      const result = await env.withAdmittedRepositoryView(
        {
          repositorySizeKb: payload.repositorySizeKb,
          prFiles,
          ...(baseSha ? { baseSha } : {}),
        },
        async (view) => {
          const snapshot = view.workspace.policySnapshot;
          const policyResult =
            snapshot.kind === "ok"
              ? await loadRepoPolicy(
                  snapshot.files
                    .filter((file) => file.path.endsWith(".mdc"))
                    .map((file) => ({ path: file.path, body: file.body })),
                  MAX_REPO_POLICY_BYTES,
                )
              : { kind: "absent" as const };
          if (baseSha == null || snapshot.kind === "unavailable") {
            logWarn("verification_repo_policy_unavailable", {
              owner: item.owner,
              repo: item.repo,
              pr: item.prNumber,
              reason: snapshot.kind === "unavailable" ? snapshot.reason : "missing_base_sha",
            });
          }
          const groundedPolicy =
            snapshot.kind === "ok" ? policyResult : { kind: "absent" as const };
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
          return { payload: runResult.payload, policyResult: groundedPolicy };
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
      if (reviewCommentsTruncated) degradation.add("objection_detection_incomplete");
      if (capped.deferred > 0) degradation.add("objection_answers_capped");
      const reasons = [...degradation];
      const objectionFields = objectionCompletionFields({
        presented: objectionCount(inventory),
        answered: publish.objectionsAnswered ?? 0,
        notObjection: publish.objectionsNotObjection ?? 0,
        deferred: capped.deferred,
        skippedIncomplete: objectionsSkippedIncomplete + (publish.objectionsSkippedIncomplete ?? 0),
      });
      if (reasons.length > 0) {
        logWarn("verification_publish_degraded", {
          owner: item.owner,
          repo: item.repo,
          pr: item.prNumber,
          resolutionStatus: resolutionResult.status,
          inventoryCompleteness: findingInventory.completeness,
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
            ...objectionFields,
          },
        };
      }
      return {
        kind: "completed",
        completion: {
          kind: "verification",
          outcome: "published",
          inventoryNarrowed,
          ...objectionFields,
        },
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
