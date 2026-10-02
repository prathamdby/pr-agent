import { isRecord } from "../../util/typeGuards.js";
import { isDeepStrictEqual } from "node:util";
import { assertPrActorLeaseHeld } from "../../agentWork/prActorLease.js";
import { AppError } from "../../errors/appError.js";
import { getWorkItemCore, shouldSkipWork } from "../../agentWork/workItemStateRepository.js";
import { createPublishContext } from "../../agentWork/publishOnce.js";
import type { TriageScope } from "../../agentWork/types.js";
import type { Pool } from "pg";
import * as v from "valibot";
import { pullRequestBranchInfo } from "../../github/listPullRequestFiles.js";
import type { PrSurface } from "../../github/prSurface.js";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import { recoverMarkedProgressComment } from "../../github/recoverPrSurfaceMutation.js";
import type { ReviewThreadResolution } from "../../github/reviewThreadResolution.js";
import { redactReviewText } from "../../review/findings/reviewPublicOutput.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import {
  TriagePayloadSchema,
  type TriagePayload,
  type TriageVerdict,
} from "../../review/triageSchema.js";
import {
  TRIAGE_BULK_PARTIAL_NOTICE,
  TRIAGE_CLOSED_PR_NOTICE,
  TRIAGE_PREVIEW_SENTINEL,
  TRIAGE_PUBLISH_LENS,
  TRIAGE_STALE_HEAD_NOTICE,
  TRIAGE_SUMMARY_SENTINEL,
  TRIAGE_THREAD_RESOLUTION_NOTICE,
  type Config,
} from "../../settings/index.js";
import {
  assertTriagePullRequestWritable,
  TriageCancelledError,
  TriageClosedPullRequestError,
} from "./triageErrors.js";
import { loadPrHeadCiState } from "../../agentWork/prHeadCiState.js";
import {
  operationIntentMarker,
  triagePreviewOperationKey,
  triagePushOperationKey,
  triageReportOperationKey,
  triageThreadOperationKey,
  publishOnce,
  throwIfExecutionAborted,
} from "../../agentWork/publishOnce.js";
import { safeRecordThreadFindingHistoryOutcome } from "../../agentWork/findingHistoryRepository.js";
import {
  StaleHeadPushError,
  type WritablePrCheckout,
} from "../../prWorkspace/writablePrCheckout.js";
import {
  classifyTriageBulkOutcomes,
  renderTriagePreview,
  renderTriageReport,
  type TriageBulkOutcome,
  type TriagePreviewHunk,
} from "./triageRender.js";

type TriagePublishCheckout = Pick<
  WritablePrCheckout,
  "headRef" | "push" | "listCommittedShas" | "listCommittedDetails"
>;

type PublishTriageParams = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly installationId: number;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkout: TriagePublishCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly payload: TriagePayload;
  readonly previouslyResolvedCount: number;
  readonly scope?: TriageScope;
  readonly threadRootCommentId?: number;
  readonly findingHistoryCfg?: Pick<Config, "findingHistory">;
  readonly leaseEpoch: number | null;
  readonly signal?: AbortSignal;
  readonly bulkOutcomes?: ReadonlyMap<number, TriageBulkOutcome>;
  readonly bulkClassification?: {
    readonly excludedIds: ReadonlySet<number>;
    readonly notInPreviewIds: ReadonlySet<number>;
    readonly commitByThreadRootCommentId: ReadonlyMap<number, string>;
    readonly commitErrors: readonly { readonly threadRootCommentId: number }[];
  };
};

type ReportOnlyParams = Omit<
  PublishTriageParams,
  "checkout" | "resolutionByRootCommentId" | "payload"
> & {
  readonly body: string;
};

type TriageCommittedDetail = {
  readonly sha: string;
  readonly subject: string;
  readonly diff: string;
};

export type TriagePushOutcome = "not-needed" | "pushed" | "stale" | "closed";

type TriagePriorPush = {
  readonly pushOutcome: TriagePushOutcome;
};

export type StoredTriagePushDetail = TriagePriorPush & {
  readonly pushedHeadSha?: string;
  readonly headRef?: string;
  readonly baseHeadSha?: string;
  readonly pushedShas?: readonly string[];
  readonly payload: TriagePayload;
  readonly commits: readonly TriageCommittedDetail[];
};

export type PublishTriageResult = {
  readonly pushOutcome: TriagePushOutcome;
  readonly missingThreadAction: boolean;
  readonly partialBulk?: boolean;
};

export function isTriagePushOutcome(value: unknown): value is TriagePushOutcome {
  return value === "not-needed" || value === "pushed" || value === "stale" || value === "closed";
}

export type StoredTriagePreviewDetail = {
  readonly headSha: string;
  readonly threadRootCommentIds: readonly number[];
  readonly hunks: readonly TriagePreviewHunk[];
  readonly payload: TriagePayload;
};

export function parseStoredTriagePreviewDetail(detail: unknown): StoredTriagePreviewDetail | null {
  if (typeof detail !== "object" || detail == null) return null;
  const entry = detail as Record<string, unknown>;
  if (typeof entry.headSha !== "string" || entry.headSha.length === 0) return null;
  if (!Array.isArray(entry.threadRootCommentIds) || !Array.isArray(entry.hunks)) return null;
  const payload = v.safeParse(TriagePayloadSchema, entry.payload);
  if (!payload.success) return null;
  const threadRootCommentIds: number[] = [];
  for (const id of entry.threadRootCommentIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
    threadRootCommentIds.push(id);
  }
  const hunks: TriagePreviewHunk[] = [];
  for (const raw of entry.hunks) {
    if (typeof raw !== "object" || raw == null) return null;
    const hunk = raw as Record<string, unknown>;
    if (
      typeof hunk.threadRootCommentId !== "number" ||
      !Number.isInteger(hunk.threadRootCommentId) ||
      hunk.threadRootCommentId <= 0 ||
      typeof hunk.subject !== "string" ||
      typeof hunk.diff !== "string"
    ) {
      return null;
    }
    hunks.push({
      threadRootCommentId: hunk.threadRootCommentId,
      subject: hunk.subject,
      diff: hunk.diff,
    });
  }
  return { headSha: entry.headSha, threadRootCommentIds, hunks, payload: payload.output };
}

function parseStoredCommit(value: unknown): TriageCommittedDetail | null {
  if (typeof value !== "object" || value == null) return null;
  const entry = value as Record<string, unknown>;
  return typeof entry.sha === "string" &&
    typeof entry.subject === "string" &&
    typeof entry.diff === "string"
    ? { sha: entry.sha, subject: entry.subject, diff: entry.diff }
    : null;
}

function inferStoredPushOutcome(
  entry: Record<string, unknown>,
  commits: readonly TriageCommittedDetail[],
): TriagePushOutcome {
  if (isTriagePushOutcome(entry.pushOutcome)) return entry.pushOutcome;
  if (entry.staleHead === true) return "stale";
  return commits.length > 0 ? "pushed" : "not-needed";
}

export function parseStoredTriagePushDetail(detail: unknown): StoredTriagePushDetail | null {
  if (typeof detail !== "object" || detail == null) return null;
  const entry = detail as Record<string, unknown>;
  const payload = v.safeParse(TriagePayloadSchema, entry.payload);
  if (!payload.success || !Array.isArray(entry.commits)) return null;
  const commits = entry.commits.map(parseStoredCommit);
  if (commits.some((commit) => commit == null)) return null;
  const parsedCommits = commits as TriageCommittedDetail[];
  return {
    payload: payload.output,
    commits: parsedCommits,
    pushOutcome: inferStoredPushOutcome(entry, parsedCommits),
    pushedHeadSha: typeof entry.pushedHeadSha === "string" ? entry.pushedHeadSha : undefined,
    headRef: typeof entry.headRef === "string" ? entry.headRef : undefined,
    baseHeadSha: typeof entry.baseHeadSha === "string" ? entry.baseHeadSha : undefined,
    pushedShas:
      Array.isArray(entry.pushedShas) && entry.pushedShas.every((sha) => typeof sha === "string")
        ? entry.pushedShas
        : undefined,
  };
}

function storedTriagePushRecord(params: {
  readonly outcome: TriagePushOutcome;
  readonly headRef: string;
  readonly headSha: string;
  readonly committedShas: readonly string[];
  readonly commits: readonly TriageCommittedDetail[];
  readonly payload: TriagePayload;
}): Record<string, unknown> {
  const shared = {
    pushOutcome: params.outcome,
    payload: params.payload,
    commits: params.commits,
    baseHeadSha: params.headSha,
    headRef: params.headRef,
  };
  if (params.outcome === "stale" || params.outcome === "closed") {
    // Preserve attempted SHAs for terminal no-push outcomes; staleHead keeps
    // the stale variant compatible with older workers.
    return {
      ...shared,
      ...(params.outcome === "stale" ? { staleHead: true } : {}),
      attemptedShas: params.committedShas,
    };
  }
  return {
    ...shared,
    pushedShas: params.committedShas,
    pushedHeadSha: params.committedShas.at(-1) ?? params.headSha,
  };
}

function shouldReplyToTriageThread(
  verdict: TriageVerdict,
): verdict is Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }> {
  switch (verdict.verdict) {
    case "fixed":
    case "already-resolved":
      return true;
    case "skipped":
    case "dismissed":
      return false;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function shouldResolveTriageThread(
  verdict: TriageVerdict,
  pushOutcome: TriagePushOutcome,
): boolean {
  switch (verdict.verdict) {
    case "skipped":
      return false;
    case "fixed":
      return pushOutcome === "pushed";
    case "already-resolved":
    case "dismissed":
      return true;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function replyBody(
  verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>,
): string {
  if (verdict.verdict === "fixed") {
    return redactReviewText(
      `**Triage**: Fixed in ${verdict.commitSha.slice(0, 7)} - ${verdict.evidence}`,
    );
  }
  return redactReviewText(`**Triage**: Already resolved - ${verdict.evidence}`);
}

async function findMarkedComment(
  prSurface: PrSurface,
  marker: string,
  rootCommentId?: number,
): Promise<{ readonly id: number } | null> {
  const botLogin = await prSurface.getBotLogin();
  const { comments } = await prSurface.listReviewComments();
  const id = findCommentIdByMarker(
    comments,
    marker,
    (comment) =>
      comment.authorLogin === botLogin &&
      (rootCommentId == null || comment.inReplyToId === rootCommentId),
  );
  return id == null ? null : { id };
}

async function replyToThread(
  params: Pick<PublishTriageParams, "prSurface" | "prNumber"> & {
    readonly thread: BotFindingThread;
    readonly verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>;
    readonly operationMarker: string;
  },
): Promise<void> {
  await params.prSurface.replyAt(
    {
      kind: "inlineReviewThread",
      prNumber: params.prNumber,
      inReplyToCommentId: params.thread.rootCommentId,
    },
    `${replyBody(params.verdict)}\n${params.operationMarker}`,
  );
}

async function upsertTriageReport(
  params: Pick<
    PublishTriageParams,
    "prSurface" | "pool" | "workItemId" | "resourceKey" | "leaseEpoch" | "signal"
  > & {
    readonly body: string;
  },
): Promise<void> {
  const operationKey = triageReportOperationKey(params.resourceKey);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const result = await publishOnce<{ readonly id: number; readonly updated: boolean }>({
    client: params.pool,
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    operationKey,
    mutationKind: "github.triage_report",
    detail: {
      step: "triage_report",
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      operationMarker,
    },
    recover: () =>
      recoverMarkedProgressComment(params.prSurface, {
        operationMarker,
        sentinel: TRIAGE_SUMMARY_SENTINEL,
      }),
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    signal: params.signal,
    mutate: async () => {
      await assertTriagePublicationActive(params);
      return params.prSurface.upsertProgressComment(
        `${redactReviewText(params.body)}\n${operationMarker}`,
        TRIAGE_SUMMARY_SENTINEL,
      );
    },
  });
  await createPublishContext(params.pool, {
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    resourceKey: params.resourceKey,
    reviewLens: TRIAGE_PUBLISH_LENS,
    step: "triage_report",
    githubId: result.id,
    detail: { updated: result.updated },
  }).record();
}

export async function publishTriageReportOnly(params: ReportOnlyParams): Promise<void> {
  await upsertTriageReport(params);
}

type PublishTriagePreviewParams = Omit<
  PublishTriageParams,
  "checkout" | "resolutionByRootCommentId"
> & {
  readonly hunks: readonly TriagePreviewHunk[];
};

export async function publishTriagePreview(params: PublishTriagePreviewParams): Promise<void> {
  const body = renderTriagePreview({
    headSha: params.headSha,
    inventory: params.inventory,
    hunks: params.hunks,
    scope: params.scope,
    threadRootCommentId: params.threadRootCommentId,
  });
  const operationKey = triagePreviewOperationKey(params.resourceKey);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const result = await publishOnce<{ readonly id: number; readonly updated: boolean }>({
    client: params.pool,
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    operationKey,
    mutationKind: "github.triage_preview",
    detail: {
      step: "triage_preview",
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      operationMarker,
    },
    recover: () =>
      recoverMarkedProgressComment(params.prSurface, {
        operationMarker,
        sentinel: TRIAGE_PREVIEW_SENTINEL,
      }),
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    mutate: () =>
      params.prSurface.upsertProgressComment(
        `${redactReviewText(body)}\n${operationMarker}`,
        TRIAGE_PREVIEW_SENTINEL,
      ),
  });
  await createPublishContext(params.pool, {
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    resourceKey: params.resourceKey,
    reviewLens: TRIAGE_PUBLISH_LENS,
    step: "triage_preview",
    githubId: result.id,
    detail: {
      headSha: params.headSha,
      threadRootCommentIds: params.inventory.map((thread) => thread.rootCommentId),
      hunks: params.hunks,
      payload: params.payload,
    } satisfies StoredTriagePreviewDetail,
  }).record();
}

export async function publishTriage(params: PublishTriageParams): Promise<PublishTriageResult> {
  return publishTriageBody(params, { kind: "fresh", checkout: params.checkout });
}

type TriagePublication =
  | { readonly kind: "fresh"; readonly checkout: TriagePublishCheckout }
  | { readonly kind: "retained"; readonly push: StoredTriagePushDetail };

type RecoveryTriageParams = Omit<PublishTriageParams, "checkout" | "payload"> & {
  readonly headRef: string;
  readonly recoveryInventory?: readonly BotFindingThread[];
};

/** Recovery selects its own retained evidence; callers cannot invent push success. */
export async function recoverTriagePublication(
  params: RecoveryTriageParams,
): Promise<PublishTriageResult | null> {
  const ctx = createPublishContext(params.pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: TRIAGE_PUBLISH_LENS,
    leaseEpoch: params.leaseEpoch,
  });
  const detail =
    (await ctx.completed("triage_push")) ??
    (await ctx.withoutNewer("triage_push", "triage_report"));
  const operationKey = triagePushOperationKey(params.resourceKey);
  const intent = detail == null ? await ctx.intent(operationKey) : null;
  if (detail == null && intent == null) return null;
  if (intent?.status === "failed") return null;
  if (
    intent != null &&
    intent.detail.__mutating !== true &&
    !Object.hasOwn(intent.detail, "__result") &&
    intent.status === "pending"
  )
    return null;
  if (intent?.detail.unknownResolution === "terminal") return ctx.failClosed(intent);
  const retained = detail ?? intent?.detail.pushPlan;
  const push = parseStoredTriagePushDetail(retained);
  if (push == null || !isRecord(retained)) {
    if (intent != null) return ctx.failClosed(intent);
    throw new AppError({
      code: "triage.invalid_stored_push",
      message: "Stored triage_push detail is invalid",
    });
  }
  if (intent != null) {
    const roots = v.safeParse(
      v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
      retained.threadRootCommentIds,
    );
    const item = await getWorkItemCore(params.pool, params.workItemId);
    const verdictIds = new Set(push.payload.verdicts.map((verdict) => verdict.threadRootCommentId));
    if (
      push.pushOutcome !== "pushed" ||
      push.headRef == null ||
      push.pushedShas == null ||
      push.baseHeadSha == null ||
      item?.headSha?.toLowerCase() !== push.baseHeadSha.toLowerCase() ||
      item.resourceKey !== params.resourceKey ||
      item.type !== "triage" ||
      !roots.success ||
      roots.output.length !== verdictIds.size ||
      new Set(roots.output).size !== verdictIds.size ||
      !roots.output.every((id) => verdictIds.has(id))
    )
      return ctx.failClosed(intent);
  }
  const inventory = retainedPublicationInventory(push, params);
  if (inventory == null || !storedPushMatchesPublication(push, { ...params, inventory })) {
    if (intent != null) return ctx.failClosed(intent);
    return null;
  }
  await assertTriagePublicationActive(params);
  if (intent != null) {
    try {
      await ctx.once<void>({
        operationKey,
        mutationKind: "github.triage_push",
        signal: params.signal,
        allowsUndefinedResult: false,
        recover: async () => {
          const pushed = await params.prSurface.listPushedCommits();
          const liveHead = await params.prSurface.getHeadSha();
          const branch = pullRequestBranchInfo((await params.prSurface.getHead()).pullRequest);
          await assertTriagePublicationActive(params);
          return branch.sameRepo &&
            branch.headRef === push.headRef &&
            liveHead.toLowerCase() === push.pushedHeadSha?.toLowerCase() &&
            push.commits.every((commit) => pushed.some((entry) => entry.sha === commit.sha))
            ? { kind: "reconciled", value: undefined }
            : { kind: "absent" };
        },
        // An interrupted push has no checkout authority. Outcome-unknown rows
        // resolve by the retained plan; no remote read can mint a new push plan.
        mutate: async () => ctx.failClosed(intent),
      });
    } catch (error) {
      await assertTriagePublicationActive(params);
      throw error;
    }
    await assertTriagePublicationActive(params);
    try {
      await assertTriagePullRequestWritable(params.prSurface);
    } catch (error) {
      if (!(error instanceof TriageClosedPullRequestError)) throw error;
      const closed = { ...push, pushOutcome: "closed" as const };
      await ctx.record({
        step: "triage_push",
        detail: storedTriagePushRecord({
          outcome: "closed",
          headSha: push.baseHeadSha ?? params.headSha,
          headRef: push.headRef ?? params.headRef,
          committedShas: push.commits.map((commit) => commit.sha),
          commits: push.commits,
          payload: push.payload,
        }),
      });
      return publishTriageBody(
        { ...params, inventory, payload: push.payload },
        { kind: "retained", push: closed },
      );
    }
    await ctx.record({ step: "triage_push", detail: retained });
  }
  return publishTriageBody(
    { ...params, inventory, payload: push.payload },
    { kind: "retained", push },
  );
}

function retainedPublicationInventory(
  push: StoredTriagePushDetail,
  params: RecoveryTriageParams,
): readonly BotFindingThread[] | null {
  if (params.recoveryInventory == null) return params.inventory;
  const ids = new Set(push.payload.verdicts.map((verdict) => verdict.threadRootCommentId));
  if (params.inventory.some((thread) => !ids.has(thread.rootCommentId))) return null;
  const inventory = params.recoveryInventory.filter((thread) => ids.has(thread.rootCommentId));
  const unresolvedIds = new Set(params.inventory.map((thread) => thread.rootCommentId));
  if (
    inventory.some(
      (thread) =>
        !unresolvedIds.has(thread.rootCommentId) &&
        params.resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved !== true,
    )
  )
    return null;
  return inventory;
}

function storedPushMatchesPublication(
  push: StoredTriagePushDetail,
  params: RecoveryTriageParams,
): boolean {
  if (push.pushOutcome === "stale" || push.pushOutcome === "closed") return false;
  if (push.pushedHeadSha?.toLowerCase() !== params.headSha.toLowerCase()) return false;
  if (push.headRef != null && push.headRef !== params.headRef) return false;
  const verdictIds = new Set(push.payload.verdicts.map((verdict) => verdict.threadRootCommentId));
  if (
    verdictIds.size !== params.inventory.length ||
    !params.inventory.every((thread) => verdictIds.has(thread.rootCommentId))
  )
    return false;
  const shas = push.commits.map((commit) => commit.sha);
  if (
    push.pushedShas != null &&
    (push.pushedShas.length !== shas.length ||
      !push.pushedShas.every((sha, index) => sha === shas[index]))
  )
    return false;
  if (push.pushOutcome === "pushed" && (shas.length === 0 || shas.at(-1) !== push.pushedHeadSha))
    return false;
  return (
    push.pushOutcome !== "pushed" ||
    !push.payload.verdicts.some(
      (verdict) => verdict.verdict === "fixed" && !shas.includes(verdict.commitSha),
    )
  );
}

async function assertTriagePublicationActive(
  params: Pick<PublishTriageParams, "pool" | "workItemId" | "signal" | "leaseEpoch">,
): Promise<void> {
  throwIfExecutionAborted(params.signal, { workItemId: params.workItemId });
  if (await shouldSkipWork(params.pool, { id: params.workItemId }))
    throw new TriageCancelledError();
  if (params.leaseEpoch != null)
    await assertPrActorLeaseHeld(params.pool, params.workItemId, params.leaseEpoch);
}

async function assertTriageWriteAllowed(
  params: Pick<PublishTriageParams, "pool" | "workItemId" | "signal" | "leaseEpoch" | "prSurface">,
): Promise<void> {
  await assertTriagePublicationActive(params);
  await assertTriagePullRequestWritable(params.prSurface);
}

async function publishTriageBody(
  params: Omit<PublishTriageParams, "checkout">,
  publication: TriagePublication,
): Promise<PublishTriageResult> {
  await assertTriagePublicationActive(params);
  let pushOutcome: TriagePushOutcome =
    publication.kind === "retained" ? publication.push.pushOutcome : "not-needed";
  let missingThreadAction = false;
  const committedShas =
    publication.kind === "fresh"
      ? publication.checkout.listCommittedShas()
      : publication.push.commits.map((commit) => commit.sha);
  const committedDetails =
    publication.kind === "fresh"
      ? publication.checkout.listCommittedDetails()
      : publication.push.commits;
  if (publication.kind === "fresh" && committedShas.length > 0) {
    try {
      const operationKey = triagePushOperationKey(params.resourceKey);
      const pushPlan = {
        ...storedTriagePushRecord({
          outcome: "pushed",
          headSha: params.headSha,
          headRef: publication.checkout.headRef,
          committedShas,
          commits: committedDetails,
          payload: params.payload,
        }),
        threadRootCommentIds: params.inventory.map((thread) => thread.rootCommentId),
      };
      const ctx = createPublishContext(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        leaseEpoch: params.leaseEpoch,
      });
      const retained = await ctx.intent(operationKey);
      if (
        retained != null &&
        (Object.hasOwn(retained.detail, "__result") ||
          retained.status === "outcome_unknown" ||
          retained.status === "reconciled" ||
          (retained.status === "pending" && retained.detail.__mutating === true)) &&
        !isDeepStrictEqual(retained.detail.pushPlan, pushPlan)
      ) {
        await ctx.failClosed(retained);
      }
      await ctx.once<void>({
        signal: params.signal,
        operationKey,
        mutationKind: "github.triage_push",
        allowsUndefinedResult: false,
        detail: {
          step: "triage_push",
          resourceKey: params.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
          pushPlan,
        },
        mutationDetail: { pushPlan },
        recover: async (intent) => {
          const plan = parseStoredTriagePushDetail(intent.detail.pushPlan);
          if (plan == null) return { kind: "absent" as const };
          const pushed = await params.prSurface.listPushedCommits();
          const liveHead = await params.prSurface.getHeadSha();
          const branch = pullRequestBranchInfo((await params.prSurface.getHead()).pullRequest);
          await assertTriagePublicationActive(params);
          return branch.sameRepo &&
            branch.headRef === plan.headRef &&
            liveHead.toLowerCase() === plan.pushedHeadSha?.toLowerCase() &&
            plan.commits.every((expected) => pushed.some((commit) => commit.sha === expected.sha))
            ? { kind: "reconciled" as const, value: undefined }
            : { kind: "absent" as const };
        },
        isKnownNoAcceptanceError: (error) =>
          error instanceof StaleHeadPushError || isKnownNoAcceptanceMutationError(error),
        mutate: async () => {
          await assertTriageWriteAllowed(params);
          await publication.checkout.push();
        },
      });
      // After intent, not inside mutate(): recover can reconcile a landed
      // push without calling push(), and a throw inside mutate() after git
      // succeeded would let that recovery publish pushed.
      await assertTriagePublicationActive(params);
      await assertTriagePullRequestWritable(params.prSurface);
      pushOutcome = "pushed";
      await createPublishContext(params.pool, {
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: storedTriagePushRecord({
          outcome: "pushed",
          headSha: params.headSha,
          headRef: publication.checkout.headRef,
          committedShas,
          commits: committedDetails,
          payload: params.payload,
        }),
      }).record();
    } catch (error) {
      if (error instanceof TriageClosedPullRequestError) {
        pushOutcome = "closed";
      } else if (error instanceof StaleHeadPushError) {
        pushOutcome = "stale";
      } else {
        throw error;
      }
      await createPublishContext(params.pool, {
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: storedTriagePushRecord({
          outcome: pushOutcome,
          headSha: params.headSha,
          headRef: publication.checkout.headRef,
          committedShas,
          commits: committedDetails,
          payload: params.payload,
        }),
      }).record();
    }
  } else if (publication.kind === "fresh") {
    await createPublishContext(params.pool, {
      workItemId: params.workItemId,
      leaseEpoch: params.leaseEpoch,
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_push",
      detail: storedTriagePushRecord({
        outcome: "not-needed",
        headSha: params.headSha,
        headRef: publication.checkout.headRef,
        committedShas: [],
        commits: [],
        payload: params.payload,
      }),
    }).record();
  }

  const actedThreadIds = new Set(
    await createPublishContext(params.pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_thread_actions",
    }).actedThreads("triage_thread_actions"),
  );
  const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
  for (const verdict of params.payload.verdicts) {
    await assertTriagePublicationActive(params);
    if (!shouldResolveTriageThread(verdict, pushOutcome)) continue;
    const thread = threadById.get(verdict.threadRootCommentId);
    const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
    if (!thread || !resolution) {
      missingThreadAction = true;
      continue;
    }
    if (resolution.isResolved) continue;
    if (
      shouldReplyToTriageThread(verdict) &&
      !actedThreadIds.has(verdict.threadRootCommentId) &&
      thread.hasTriageReply !== true
    ) {
      const operationKey = triageThreadOperationKey(verdict.threadRootCommentId);
      const operationMarker = operationIntentMarker(operationKey, params.workItemId);
      await publishOnce<void>({
        client: params.pool,
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        signal: params.signal,
        operationKey,
        mutationKind: "github.triage_thread_reply",
        allowsUndefinedResult: true,
        detail: {
          step: "triage_thread_actions",
          resourceKey: params.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
          threadRootCommentId: verdict.threadRootCommentId,
          operationMarker,
        },
        recover: async () => {
          const existing = await findMarkedComment(
            params.prSurface,
            operationMarker,
            verdict.threadRootCommentId,
          );
          return existing == null
            ? { kind: "absent" as const }
            : { kind: "reconciled" as const, value: undefined };
        },
        isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
        mutate: async () => {
          await assertTriagePublicationActive(params);
          return replyToThread({
            ...params,
            thread,
            verdict,
            operationMarker,
          });
        },
      });
      actedThreadIds.add(verdict.threadRootCommentId);
      await createPublishContext(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_thread_actions",
        leaseEpoch: params.leaseEpoch,
      }).recordActedThreads("triage_thread_actions", [...actedThreadIds]);
    }
    const operationKey = `${triageThreadOperationKey(verdict.threadRootCommentId)}:resolve`;
    await publishOnce<void>({
      client: params.pool,
      workItemId: params.workItemId,
      leaseEpoch: params.leaseEpoch,
      signal: params.signal,
      operationKey,
      mutationKind: "github.triage_thread_resolve",
      allowsUndefinedResult: true,
      detail: {
        step: "triage_thread_actions",
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        threadRootCommentId: verdict.threadRootCommentId,
      },
      recover: async () => {
        const current = await params.prSurface.listInlineReviewThreads();
        return current.byRootCommentId.get(verdict.threadRootCommentId)?.isResolved === true
          ? { kind: "reconciled" as const, value: undefined }
          : { kind: "absent" as const };
      },
      isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
      mutate: async () => {
        await assertTriagePublicationActive(params);
        await params.prSurface.resolveInlineReviewThread(resolution.threadNodeId);
      },
    });
  }

  const bulkOutcomes =
    params.bulkClassification != null
      ? classifyTriageBulkOutcomes({
          inventory: params.inventory,
          payload: params.payload,
          commitByThreadRootCommentId: params.bulkClassification.commitByThreadRootCommentId,
          commitErrors: params.bulkClassification.commitErrors,
          excludedIds: params.bulkClassification.excludedIds,
          notInPreviewIds: params.bulkClassification.notInPreviewIds,
          pushed: pushOutcome === "pushed",
        })
      : params.bulkOutcomes;
  const partialBulk =
    bulkOutcomes != null &&
    [...bulkOutcomes.values()].some((outcome) => outcome === "applied") &&
    [...bulkOutcomes.values()].some((outcome) => outcome === "failed");

  const ciHeadSha =
    pushOutcome === "pushed" ? (committedDetails.at(-1)?.sha ?? params.headSha) : params.headSha;
  const ciRow = await loadPrHeadCiState(params.pool, params.owner, params.repo, ciHeadSha);

  await assertTriagePublicationActive(params);
  await upsertTriageReport({
    ...params,
    body: renderTriageReport({
      headSha: params.headSha,
      ciRollup: {
        headSha: ciHeadSha,
        version: ciRow?.version ?? 0,
        rollup: ciRow?.rollup ?? "none",
      },
      inventory: params.inventory,
      payload: params.payload,
      commits: pushOutcome === "pushed" ? committedDetails : [],
      previouslyResolvedCount: params.previouslyResolvedCount,
      notice: [
        pushOutcome === "closed" ? TRIAGE_CLOSED_PR_NOTICE : undefined,
        pushOutcome === "stale" ? TRIAGE_STALE_HEAD_NOTICE : undefined,
        missingThreadAction ? TRIAGE_THREAD_RESOLUTION_NOTICE : undefined,
        partialBulk ? TRIAGE_BULK_PARTIAL_NOTICE : undefined,
      ]
        .filter((notice) => notice != null)
        .join("\n\n"),
      scope: params.scope,
      threadRootCommentId: params.threadRootCommentId,
      bulkOutcomes,
    }),
  });

  if (params.findingHistoryCfg) {
    const activeThreadById = new Map(
      params.inventory.map((thread) => [thread.rootCommentId, thread]),
    );
    for (const verdict of params.payload.verdicts) {
      const thread = activeThreadById.get(verdict.threadRootCommentId);
      if (!thread) continue;
      safeRecordThreadFindingHistoryOutcome(params.pool, params.findingHistoryCfg, {
        scope: {
          installationId: params.installationId,
          owner: params.owner,
          repo: params.repo,
          prNumber: params.prNumber,
          workItemId: params.workItemId,
          headSha: params.headSha,
        },
        resourceKey: params.resourceKey,
        thread,
        outcome: verdict.verdict,
      });
    }
  }

  return { pushOutcome, missingThreadAction, ...(partialBulk ? { partialBulk: true } : {}) };
}
