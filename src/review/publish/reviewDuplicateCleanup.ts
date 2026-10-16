import { publishOnce, reviewDuplicateOperationKey } from "../../agentWork/publishOnce.js";
import { prResourceKey } from "../../agentWork/types.js";
import { fenceForEpoch } from "../../agentWork/writeFence.js";
import { errorMessage } from "../../errors/errorMessage.js";
import { logWarn } from "../../evlog.js";
import {
  duplicateStepApplied,
  executeDuplicateCleanup,
  planDuplicateCleanup,
  planSameIdCleanup,
  type DuplicateCleanupDeps,
  type DuplicateCleanupPlan,
  type DuplicateCleanupRefusal,
} from "../findingIdentity/duplicateCleanup.js";
import type { FindingInventory } from "../findingIdentity/findingInventory.js";
import type { CleanedDuplicate } from "../findingIdentity/findingLifecycle.js";
import type { FindingId } from "../findingIdentity/findingMarker.js";
import { threadMutationLock } from "../findingIdentity/threadMutationLock.js";
import type { ReviewPublishSession } from "./reviewPublishSession.js";

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

function planIds(plan: DuplicateCleanupPlan): FindingId[] {
  return [plan.canonical.id, ...plan.duplicates.map((entry) => entry.finding.id)];
}

function cleanupDeps(session: ReviewPublishSession): DuplicateCleanupDeps {
  const { prSurface, ctx, operationIntent } = session;
  const surface = {
    prNumber: ctx.prNumber,
    getBotLogin: () => prSurface.getBotLogin(),
    getReviewThread: (threadNodeId: string) => prSurface.getReviewThread(threadNodeId),
    replyAt: (target: Parameters<DuplicateCleanupDeps["surface"]["replyAt"]>[0], body: string) =>
      prSurface.replyAt(target, body),
    resolveInlineReviewThread: (threadNodeId: string) =>
      prSurface.resolveInlineReviewThread(threadNodeId),
  };
  return {
    surface,
    withThreadLock: threadMutationLock(
      session.pool ?? session.verdict?.pool,
      operationIntent?.resourceKey ?? prResourceKey(ctx.owner, ctx.repo, ctx.prNumber),
    ),
    publishStep: async (step, mutate) => {
      if (operationIntent == null) return mutate();
      await publishOnce<void>({
        fence: fenceForEpoch(operationIntent.leaseEpoch),
        client: operationIntent.client,
        workItemId: operationIntent.workItemId,
        leaseEpoch: operationIntent.leaseEpoch,
        operationKey: reviewDuplicateOperationKey(step),
        mutationKind: `github.review_${step.kind}`,
        allowsUndefinedResult: true,
        detail: {
          resourceKey: operationIntent.resourceKey,
          reviewLens: session.mode,
          duplicateId: step.duplicateId,
          canonicalId: step.canonicalId,
          threadId: step.threadId,
        },
        recover: async () =>
          (await duplicateStepApplied(surface, step))
            ? { kind: "reconciled" as const, value: undefined }
            : { kind: "absent" as const },
        mutate,
      });
    },
  };
}

async function runCleanup(
  session: ReviewPublishSession,
  plans: readonly DuplicateCleanupPlan[],
): Promise<readonly CleanedDuplicate[]> {
  if (plans.length === 0) return [];
  const warn = (fields: Record<string, unknown>, error: unknown) =>
    logWarn("review_duplicate_cleanup_failed", {
      owner: session.ctx.owner,
      repo: session.ctx.repo,
      pr: session.ctx.prNumber,
      ...fields,
      message: errorMessage(error),
    });
  try {
    if ((await session.stopReason()) != null) return [];
  } catch (error) {
    warn({}, error);
    return [];
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
            canonicalUrl: outcome.canonicalUrl,
            resolved: outcome.outcome === "resolved",
          });
        }
      } catch (error) {
        warn({ duplicateId: entry.finding.id, canonicalId: plan.canonical.id }, error);
      }
    }
  }
  return cleaned;
}

export function createReviewDuplicateCleanup(inventory: FindingInventory): ReviewDuplicateCleanup {
  let accepted: readonly DuplicateCleanupPlan[] = [];
  let cleaned: Promise<readonly CleanedDuplicate[]> | null = null;
  return {
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
  };
}
