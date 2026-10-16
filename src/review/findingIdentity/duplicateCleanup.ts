import type { ReplyTarget } from "../../agentWork/types.js";
import type { ReviewThreadSnapshot } from "../../github/reviewThreadResolution.js";
import {
  hasHumanReplies,
  type FindingInventory,
  type InventoryFinding,
} from "./findingInventory.js";
import { parseOwnedReceipts, renderReceipt, type FindingId } from "./findingMarker.js";
import { overlaps } from "./findingReconcile.js";

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

function compareAge(left: InventoryFinding, right: InventoryFinding): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return (left.rootCommentId ?? 0) - (right.rootCommentId ?? 0);
}

export function selectCanonical(group: readonly InventoryFinding[]): InventoryFinding {
  const [first] = group.toSorted(
    (left, right) =>
      Number(left.aliasOf != null) - Number(right.aliasOf != null) ||
      Number(right.hasHumanReplies) - Number(left.hasHumanReplies) ||
      compareAge(left, right),
  );
  if (first == null) throw new Error("duplicate group is empty");
  return first;
}

function memberRefusal(
  finding: InventoryFinding,
  groupIds: ReadonlySet<FindingId>,
): DuplicateCleanupRefusal | null {
  if (finding.state !== "open") return "not_open";
  if (finding.source !== "thread" || finding.threadId == null || finding.rootCommentId == null) {
    return "not_thread";
  }
  if (!finding.commentsComplete) return "comments_incomplete";
  if (finding.aliasOf != null && !groupIds.has(finding.aliasOf)) return "aliased";
  return null;
}

function placementRefusal(
  canonical: InventoryFinding,
  duplicate: InventoryFinding,
): DuplicateCleanupRefusal | null {
  if (duplicate.path !== canonical.path) return "different_file";
  if (canonical.positionStale || canonical.line == null) return null;
  const span = {
    file: canonical.path,
    startLine: Math.min(canonical.startLine ?? canonical.line, canonical.line),
    endLine: Math.max(canonical.startLine ?? canonical.line, canonical.line),
  };
  return overlaps(span, duplicate) ? null : "not_overlapping";
}

function cleanupEntries(
  canonical: InventoryFinding,
  members: readonly InventoryFinding[],
): DuplicateCleanupEntry[] {
  return members
    .filter((member) => member !== canonical)
    .toSorted(compareAge)
    .map((finding) => ({ finding, resolve: !finding.hasHumanReplies }));
}

export function planDuplicateCleanup(
  ids: readonly FindingId[],
  inventory: FindingInventory,
): DuplicateCleanupPlan | { readonly refused: DuplicateCleanupRefusal } {
  if (inventory.completeness !== "complete") return { refused: "inventory_incomplete" };
  const groupIds = new Set(ids);
  if (groupIds.size < 2) return { refused: "too_few" };
  const members: InventoryFinding[] = [];
  for (const id of groupIds) {
    const finding = inventory.findings.get(id);
    if (finding == null) return { refused: "unknown_finding" };
    members.push(finding);
  }
  for (const member of members) {
    const refused = memberRefusal(member, groupIds);
    if (refused != null) return { refused };
  }
  const canonical = selectCanonical(members);
  if (canonical.aliasOf != null) return { refused: "aliased" };
  for (const member of members) {
    if (member === canonical) continue;
    const refused = placementRefusal(canonical, member);
    if (refused != null) return { refused };
  }
  return { canonical, duplicates: cleanupEntries(canonical, members) };
}

export function planSameIdCleanup(inventory: FindingInventory): DuplicateCleanupPlan[] {
  if (inventory.completeness !== "complete") return [];
  const copiesById = new Map<FindingId, InventoryFinding[]>();
  for (const copy of inventory.sameIdCopies) {
    if (copy.state !== "open" || copy.threadId == null || copy.rootCommentId == null) continue;
    if (!copy.commentsComplete) continue;
    copiesById.set(copy.id, [...(copiesById.get(copy.id) ?? []), copy]);
  }
  return [...copiesById].flatMap(([id, copies]) => {
    const canonical = inventory.findings.get(id);
    if (canonical == null || canonical.source !== "thread") return [];
    return [{ canonical, duplicates: cleanupEntries(canonical, copies) }];
  });
}

function hasDuplicateReceipt(
  thread: ReviewThreadSnapshot,
  botLogin: string,
  duplicateId: FindingId,
  canonicalId: FindingId,
): boolean {
  return parseOwnedReceipts(thread.comments, botLogin).some(
    (receipt) =>
      receipt.kind === "duplicate" &&
      receipt.id === duplicateId &&
      receipt.canonical === canonicalId,
  );
}

export async function duplicateStepApplied(
  surface: Pick<DuplicateCleanupSurface, "getBotLogin" | "getReviewThread">,
  step: DuplicateCleanupStep,
): Promise<boolean> {
  const [botLogin, thread] = await Promise.all([
    surface.getBotLogin(),
    surface.getReviewThread(step.threadId),
  ]);
  if (thread == null) return false;
  return step.kind === "duplicate_resolve"
    ? thread.isResolved
    : hasDuplicateReceipt(thread, botLogin, step.duplicateId, step.canonicalId);
}

function resolvable(thread: ReviewThreadSnapshot, botLogin: string): boolean {
  return thread.commentsComplete && !hasHumanReplies(thread, botLogin);
}

function duplicateReplyBody(entry: DuplicateCleanupEntry, plan: DuplicateCleanupPlan): string {
  const action = entry.resolve
    ? "Resolving this copy."
    : "Leaving this copy open because it has replies.";
  const receipt = renderReceipt({
    kind: "duplicate",
    id: entry.finding.id,
    canonical: plan.canonical.id,
  });
  return `Tracked in ${plan.canonical.url}. ${action}\n\n${receipt}`;
}

async function cleanEntry(
  plan: DuplicateCleanupPlan,
  entry: DuplicateCleanupEntry,
  deps: DuplicateCleanupDeps,
): Promise<DuplicateCleanupOutcome["outcome"]> {
  const { threadId, rootCommentId } = entry.finding;
  if (threadId == null || rootCommentId == null) return "skipped";
  const step = (kind: DuplicateCleanupStep["kind"]): DuplicateCleanupStep => ({
    kind,
    duplicateId: entry.finding.id,
    canonicalId: plan.canonical.id,
    threadId,
  });
  return deps.withThreadLock(async () => {
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
    if (current == null || !resolvable(current, botLogin)) return receipted ? "skipped" : "linked";
    await deps.publishStep(step("duplicate_resolve"), () =>
      deps.surface.resolveInlineReviewThread(threadId),
    );
    return "resolved";
  });
}

export async function executeDuplicateCleanup(
  plan: DuplicateCleanupPlan,
  deps: DuplicateCleanupDeps,
): Promise<DuplicateCleanupOutcome[]> {
  const outcomes: DuplicateCleanupOutcome[] = [];
  for (const entry of plan.duplicates) {
    outcomes.push({
      duplicateId: entry.finding.id,
      canonicalId: plan.canonical.id,
      canonicalUrl: plan.canonical.url,
      outcome: await cleanEntry(plan, entry, deps),
    });
  }
  return outcomes;
}
