import { publishOnce, reviewDuplicateOperationKey } from "../../state/publish.ts";
import { prResourceKey } from "../../agentWork/types.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import { logWarn } from "../../evlog.ts";
import {
  duplicateStepApplied,
  executeDuplicateCleanup,
  planDuplicateCleanup,
  planSameIdCleanup,
  type DuplicateCleanupDeps,
  type DuplicateCleanupPlan,
  type DuplicateCleanupRefusal,
} from "../findingIdentity/duplicateCleanup.ts";
import type { FindingInventory } from "../findingIdentity/findingInventory.ts";
import type { CleanedDuplicate } from "../findingIdentity/findingLifecycle.ts";
import type { FindingId } from "../findingIdentity/findingMarker.ts";
import { threadMutationLock } from "../findingIdentity/threadMutationLock.ts";
import type { ReviewPublishSession } from "./reviewPublishSession.ts";

export type DeclaredDuplicate =
  | {
      readonly kind: "accepted";
      readonly canonicalId: FindingId;
      readonly resolves: readonly FindingId[];
      readonly linksOnly: readonly FindingId[];
    }
  | { readonly kind: "refused"; readonly reason: DuplicateCleanupRefusal };

export type ReviewDuplicateCleanup = {
  readonly declare: (ids: readonly FindingId[]) => DeclaredDuplicate;
  readonly clean: (session: ReviewPublishSession) => Promise<readonly CleanedDuplicate[]>;
};

function planIds(plan: DuplicateCleanupPlan) {
  return ((pinnedReturn: FindingId[]) => pinnedReturn)([
    plan.canonical.id,
    ...plan.duplicates.map((entry) => entry.finding.id),
  ]);
}

function cleanupDeps(session: ReviewPublishSession) {
  const { prSurface, ctx } = session;
  const target = session.publish;
  const surface = {
    prNumber: ctx.prNumber,
    getBotLogin: () => prSurface.getBotLogin(),
    getReviewThread: (threadNodeId: string) => prSurface.getReviewThread(threadNodeId),
    replyAt: (
      replyTarget: Parameters<DuplicateCleanupDeps["surface"]["replyAt"]>[0],
      body: string,
    ) => prSurface.replyAt(replyTarget, body),
    resolveInlineReviewThread: (threadNodeId: string) =>
      prSurface.resolveInlineReviewThread(threadNodeId),
  };
  return ((pinnedReturn: DuplicateCleanupDeps) => pinnedReturn)({
    surface,
    withThreadLock: threadMutationLock(
      target?.resourceKey ?? prResourceKey(ctx.owner, ctx.repo, ctx.prNumber),
    ),
    publishStep: async (step, mutate) => {
      if (target == null) return mutate();
      await publishOnce({
        db: target.db,
        workId: target.workItemId,
        prKey: target.resourceKey,
        resourceTarget: `thread:${step.threadId}`,
        ...(target.laneEpoch !== undefined ? { laneEpoch: target.laneEpoch } : {}),
        ...(target.shutdownRequested !== undefined
          ? { shutdownRequested: target.shutdownRequested }
          : {}),
        ...(target.signal !== undefined ? { signal: target.signal } : {}),
        operationKey: reviewDuplicateOperationKey(step),
        mutationKind: `github.review_${step.kind}`,
        allowsUndefinedResult: true,
        identity: {
          resourceKey: target.resourceKey,
          reviewLens: session.mode,
          duplicateId: step.duplicateId,
          canonicalId: step.canonicalId,
          threadId: step.threadId,
        },
        recover: async () =>
          (await duplicateStepApplied(surface, step))
            ? { found: true as const, value: undefined }
            : { found: false as const },
        mutate,
      });
    },
  });
}

async function runCleanup(session: ReviewPublishSession, plans: readonly DuplicateCleanupPlan[]) {
  if (plans.length === 0)
    return ((pinnedReturn: readonly CleanedDuplicate[] | Promise<readonly CleanedDuplicate[]>) =>
      pinnedReturn)([]);
  const warn = (fields: Record<string, unknown>, error: unknown) =>
    logWarn("review_duplicate_cleanup_failed", {
      owner: session.ctx.owner,
      repo: session.ctx.repo,
      pr: session.ctx.prNumber,
      ...fields,
      message: errorMessage(error),
    });
  try {
    if ((await session.stopReason()) != null)
      return ((pinnedReturn: readonly CleanedDuplicate[] | Promise<readonly CleanedDuplicate[]>) =>
        pinnedReturn)([]);
  } catch (error) {
    warn({}, error);
    return ((pinnedReturn: readonly CleanedDuplicate[] | Promise<readonly CleanedDuplicate[]>) =>
      pinnedReturn)([]);
  }
  const deps = cleanupDeps(session);
  const cleaned: CleanedDuplicate[] = [];
  for (const plan of plans) {
    for (const entry of plan.duplicates) {
      try {
        const outcomes = await executeDuplicateCleanup({ ...plan, duplicates: [entry] }, deps);
        for (const outcome of outcomes) {
          if (outcome.outcome === "skipped") continue;
          cleaned.push({
            id: outcome.duplicateId,
            canonicalId: outcome.canonicalId,
            canonicalUrl: outcome.canonicalUrl,
            resolved: outcome.outcome === "resolved",
            ...(entry.finding.threadId == null ? {} : { threadId: entry.finding.threadId }),
          });
        }
      } catch (error) {
        warn({ duplicateId: entry.finding.id, canonicalId: plan.canonical.id }, error);
      }
    }
  }
  return ((pinnedReturn: readonly CleanedDuplicate[] | Promise<readonly CleanedDuplicate[]>) =>
    pinnedReturn)(cleaned);
}

export function createReviewDuplicateCleanup(inventory: FindingInventory) {
  let accepted: readonly DuplicateCleanupPlan[] = [];
  let cleaned: Promise<readonly CleanedDuplicate[]> | null = null;
  return ((pinnedReturn: ReviewDuplicateCleanup) => pinnedReturn)({
    declare: (ids) => {
      const declared = new Set(ids);
      const overlapping = accepted.filter((plan) => planIds(plan).some((id) => declared.has(id)));
      const plan = planDuplicateCleanup(
        [...new Set([...ids, ...overlapping.flatMap(planIds)])],
        inventory,
      );
      if ("refused" in plan) return { kind: "refused", reason: plan.refused };
      accepted = [...accepted.filter((existing) => !overlapping.includes(existing)), plan];
      return {
        kind: "accepted",
        canonicalId: plan.canonical.id,
        resolves: plan.duplicates.filter((entry) => entry.resolve).map((entry) => entry.finding.id),
        linksOnly: plan.duplicates
          .filter((entry) => !entry.resolve)
          .map((entry) => entry.finding.id),
      };
    },
    clean: (session) => {
      cleaned ??= runCleanup(session, [...accepted, ...planSameIdCleanup(inventory)]);
      return cleaned;
    },
  });
}
