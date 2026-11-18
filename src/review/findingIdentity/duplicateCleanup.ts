import type { ReplyTarget } from "../../agentWork/types.ts";
import type { ReviewThreadSnapshot } from "../../github/reviewThreadResolution.ts";
import {
  hasHumanReplies,
  type FindingInventory,
  type InventoryFinding,
} from "./findingInventory.ts";
import { parseOwnedReceipts, renderReceipt, type FindingId } from "./findingMarker.ts";
import { overlaps } from "./findingReconcile.ts";

export type DuplicateCleanupRefusal =
  | "inventory_incomplete"
  | "too_few"
  | "unknown_finding"
  | "not_open"
  | "not_thread"
  | "comments_incomplete"
  | "aliased"
  | "different_file"
  | "not_overlapping";

export type DuplicateCleanupEntry = {
  readonly finding: InventoryFinding;
  readonly resolve: boolean;
};

export type DuplicateCleanupPlan = {
  readonly canonical: InventoryFinding;
  readonly duplicates: readonly DuplicateCleanupEntry[];
};

export type DuplicateCleanupStep = {
  readonly kind: "duplicate_reply" | "duplicate_resolve";
  readonly duplicateId: FindingId;
  readonly canonicalId: FindingId;
  readonly threadId: string;
};

export type DuplicateCleanupOutcome = {
  readonly duplicateId: FindingId;
  readonly canonicalId: FindingId;
  readonly canonicalUrl: string;
  readonly outcome: "resolved" | "linked" | "skipped";
};

export type DuplicateCleanupSurface = {
  readonly prNumber: number;
  readonly getBotLogin: () => Promise<string>;
  readonly getReviewThread: (threadNodeId: string) => Promise<ReviewThreadSnapshot | null>;
  readonly replyAt: (
    target: Extract<ReplyTarget, { readonly kind: "inlineReviewThread" }>,
    body: string,
  ) => Promise<unknown>;
  readonly resolveInlineReviewThread: (threadNodeId: string) => Promise<void>;
};

export type DuplicateCleanupDeps = {
  readonly surface: DuplicateCleanupSurface;
  readonly withThreadLock: <T>(apply: () => Promise<T>) => Promise<T>;
  readonly publishStep: (step: DuplicateCleanupStep, mutate: () => Promise<void>) => Promise<void>;
};

function compareAge(left: InventoryFinding, right: InventoryFinding) {
  if (left.createdAt !== right.createdAt)
    return ((pinnedReturn: number) => pinnedReturn)(left.createdAt < right.createdAt ? -1 : 1);
  if (left.id !== right.id)
    return ((pinnedReturn: number) => pinnedReturn)(left.id < right.id ? -1 : 1);
  return ((pinnedReturn: number) => pinnedReturn)(
    (left.rootCommentId ?? 0) - (right.rootCommentId ?? 0),
  );
}

export function selectCanonical(group: readonly InventoryFinding[]) {
  const [first] = group.toSorted(
    (left, right) =>
      Number(left.aliasOf != null) - Number(right.aliasOf != null) ||
      Number(right.hasHumanReplies) - Number(left.hasHumanReplies) ||
      compareAge(left, right),
  );
  if (first == null) throw new Error("duplicate group is empty");
  return ((pinnedReturn: InventoryFinding) => pinnedReturn)(first);
}

function memberRefusal(finding: InventoryFinding, groupIds: ReadonlySet<FindingId>) {
  if (finding.state !== "open")
    return ((pinnedReturn: DuplicateCleanupRefusal | null) => pinnedReturn)("not_open");
  if (finding.source !== "thread" || finding.threadId == null || finding.rootCommentId == null) {
    return ((pinnedReturn: DuplicateCleanupRefusal | null) => pinnedReturn)("not_thread");
  }
  if (!finding.commentsComplete)
    return ((pinnedReturn: DuplicateCleanupRefusal | null) => pinnedReturn)("comments_incomplete");
  if (finding.aliasOf != null && !groupIds.has(finding.aliasOf))
    return ((pinnedReturn: DuplicateCleanupRefusal | null) => pinnedReturn)("aliased");
  return ((pinnedReturn: DuplicateCleanupRefusal | null) => pinnedReturn)(null);
}

function placementRefusal(canonical: InventoryFinding, duplicate: InventoryFinding) {
  if (duplicate.path !== canonical.path)
    return ((pinnedReturn: DuplicateCleanupRefusal | null) => pinnedReturn)("different_file");
  if (canonical.positionStale || canonical.line == null)
    return ((pinnedReturn: DuplicateCleanupRefusal | null) => pinnedReturn)(null);
  const span = {
    file: canonical.path,
    startLine: Math.min(canonical.startLine ?? canonical.line, canonical.line),
    endLine: Math.max(canonical.startLine ?? canonical.line, canonical.line),
  };
  return ((pinnedReturn: DuplicateCleanupRefusal | null) => pinnedReturn)(
    overlaps(span, duplicate) ? null : "not_overlapping",
  );
}

function cleanupEntries(canonical: InventoryFinding, members: readonly InventoryFinding[]) {
  return ((pinnedReturn: DuplicateCleanupEntry[]) => pinnedReturn)(
    members
      .filter((member) => member !== canonical)
      .toSorted(compareAge)
      .map((finding) => ({ finding, resolve: !finding.hasHumanReplies })),
  );
}

export function planDuplicateCleanup(ids: readonly FindingId[], inventory: FindingInventory) {
  if (inventory.completeness !== "complete")
    return ((pinnedReturn: DuplicateCleanupPlan | { readonly refused: DuplicateCleanupRefusal }) =>
      pinnedReturn)({ refused: "inventory_incomplete" });
  const groupIds = new Set(ids);
  if (groupIds.size < 2)
    return ((pinnedReturn: DuplicateCleanupPlan | { readonly refused: DuplicateCleanupRefusal }) =>
      pinnedReturn)({ refused: "too_few" });
  const members: InventoryFinding[] = [];
  for (const id of groupIds) {
    const finding = inventory.findings.get(id);
    if (finding == null)
      return ((
        pinnedReturn: DuplicateCleanupPlan | { readonly refused: DuplicateCleanupRefusal },
      ) => pinnedReturn)({ refused: "unknown_finding" });
    members.push(finding);
  }
  for (const member of members) {
    const refused = memberRefusal(member, groupIds);
    if (refused != null)
      return ((
        pinnedReturn: DuplicateCleanupPlan | { readonly refused: DuplicateCleanupRefusal },
      ) => pinnedReturn)({ refused });
  }
  const canonical = selectCanonical(members);
  if (canonical.aliasOf != null)
    return ((pinnedReturn: DuplicateCleanupPlan | { readonly refused: DuplicateCleanupRefusal }) =>
      pinnedReturn)({ refused: "aliased" });
  for (const member of members) {
    if (member === canonical) continue;
    const refused = placementRefusal(canonical, member);
    if (refused != null)
      return ((
        pinnedReturn: DuplicateCleanupPlan | { readonly refused: DuplicateCleanupRefusal },
      ) => pinnedReturn)({ refused });
  }
  return ((pinnedReturn: DuplicateCleanupPlan | { readonly refused: DuplicateCleanupRefusal }) =>
    pinnedReturn)({ canonical, duplicates: cleanupEntries(canonical, members) });
}

export function planSameIdCleanup(inventory: FindingInventory) {
  if (inventory.completeness !== "complete")
    return ((pinnedReturn: DuplicateCleanupPlan[]) => pinnedReturn)([]);
  const copiesById = new Map<FindingId, InventoryFinding[]>();
  for (const copy of inventory.sameIdCopies) {
    if (copy.state !== "open" || copy.threadId == null || copy.rootCommentId == null) continue;
    if (!copy.commentsComplete) continue;
    copiesById.set(copy.id, [...(copiesById.get(copy.id) ?? []), copy]);
  }
  return ((pinnedReturn: DuplicateCleanupPlan[]) => pinnedReturn)(
    [...copiesById].flatMap(([id, copies]) => {
      const canonical = inventory.findings.get(id);
      if (canonical == null || canonical.source !== "thread") return [];
      return [{ canonical, duplicates: cleanupEntries(canonical, copies) }];
    }),
  );
}

function hasDuplicateReceipt(
  thread: ReviewThreadSnapshot,
  botLogin: string,
  duplicateId: FindingId,
  canonicalId: FindingId,
) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    parseOwnedReceipts(thread.comments, botLogin).some(
      (receipt) =>
        receipt.kind === "duplicate" &&
        receipt.id === duplicateId &&
        receipt.canonical === canonicalId,
    ),
  );
}

export async function duplicateStepApplied(
  surface: Pick<DuplicateCleanupSurface, "getBotLogin" | "getReviewThread">,
  step: DuplicateCleanupStep,
) {
  const [botLogin, thread] = await Promise.all([
    surface.getBotLogin(),
    surface.getReviewThread(step.threadId),
  ]);
  if (thread == null) return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(
    step.kind === "duplicate_resolve"
      ? thread.isResolved
      : hasDuplicateReceipt(thread, botLogin, step.duplicateId, step.canonicalId),
  );
}

function resolvable(thread: ReviewThreadSnapshot, botLogin: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    thread.commentsComplete && !hasHumanReplies(thread, botLogin),
  );
}

function duplicateReplyBody(entry: DuplicateCleanupEntry, plan: DuplicateCleanupPlan) {
  const action = entry.resolve
    ? "Resolving this copy."
    : "Leaving this copy open because it has replies.";
  const receipt = renderReceipt({
    kind: "duplicate",
    id: entry.finding.id,
    canonical: plan.canonical.id,
  });
  return ((pinnedReturn: string) => pinnedReturn)(
    `Tracked in ${plan.canonical.url}. ${action}\n\n${receipt}`,
  );
}

async function cleanEntry(
  plan: DuplicateCleanupPlan,
  entry: DuplicateCleanupEntry,
  deps: DuplicateCleanupDeps,
) {
  const { threadId, rootCommentId } = entry.finding;
  if (threadId == null || rootCommentId == null)
    return ((
      pinnedReturn:
        | DuplicateCleanupOutcome["outcome"]
        | Promise<DuplicateCleanupOutcome["outcome"]>,
    ) => pinnedReturn)("skipped");
  const step = (kind: DuplicateCleanupStep["kind"]) =>
    ((pinnedReturn: DuplicateCleanupStep) => pinnedReturn)({
      kind,
      duplicateId: entry.finding.id,
      canonicalId: plan.canonical.id,
      threadId,
    });
  return ((
    pinnedReturn: DuplicateCleanupOutcome["outcome"] | Promise<DuplicateCleanupOutcome["outcome"]>,
  ) => pinnedReturn)(
    deps.withThreadLock(async () => {
      const botLogin = await deps.surface.getBotLogin();
      const before = await deps.surface.getReviewThread(threadId);
      if (before == null || before.isResolved) return "skipped";
      const receipted = hasDuplicateReceipt(before, botLogin, entry.finding.id, plan.canonical.id);
      const resolve = entry.resolve && resolvable(before, botLogin);
      if (!receipted) {
        await deps.publishStep(step("duplicate_reply"), async () => {
          await deps.surface.replyAt(
            {
              kind: "inlineReviewThread",
              prNumber: deps.surface.prNumber,
              inReplyToCommentId: rootCommentId,
            },
            duplicateReplyBody({ ...entry, resolve }, plan),
          );
        });
      }
      if (!resolve) return receipted ? "skipped" : "linked";
      const current = await deps.surface.getReviewThread(threadId);
      if (current?.isResolved === true) return receipted ? "skipped" : "resolved";
      if (current == null || !resolvable(current, botLogin))
        return receipted ? "skipped" : "linked";
      await deps.publishStep(step("duplicate_resolve"), () =>
        deps.surface.resolveInlineReviewThread(threadId),
      );
      return "resolved";
    }),
  );
}

export async function executeDuplicateCleanup(
  plan: DuplicateCleanupPlan,
  deps: DuplicateCleanupDeps,
) {
  const outcomes: DuplicateCleanupOutcome[] = [];
  for (const entry of plan.duplicates) {
    outcomes.push({
      duplicateId: entry.finding.id,
      canonicalId: plan.canonical.id,
      canonicalUrl: plan.canonical.url,
      outcome: await cleanEntry(plan, entry, deps),
    });
  }
  return ((pinnedReturn: DuplicateCleanupOutcome[] | Promise<DuplicateCleanupOutcome[]>) =>
    pinnedReturn)(outcomes);
}
