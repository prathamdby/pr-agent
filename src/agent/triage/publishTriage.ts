import { decodeProgressComment } from "../../github/prSurfaceResults.ts";
import { isRecord } from "../../util/typeGuards.ts";
import { isDeepStrictEqual } from "node:util";
import { AppError } from "../../errors/appError.ts";
import type { TriageScope } from "../../agentWork/types.ts";
import * as v from "valibot";
import { pullRequestBranchInfo } from "../../github/listPullRequestFiles.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.ts";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.ts";
import { recoverMarkedProgressComment } from "../../github/recoverPrSurfaceMutation.ts";
import type { ReviewThreadResolution } from "../../github/reviewThreadResolution.ts";
import { redactReviewText } from "../../review/findings/reviewPublicOutput.ts";
import {
  appendRootResolutionReceipt,
  unpostedResolutionReceipt,
} from "../../review/findingIdentity/resolutionReceipt.ts";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.ts";
import {
  TriagePayloadSchema,
  type TriagePayload,
  type TriageVerdict,
} from "../../review/triageSchema.ts";
import {
  TRIAGE_BULK_PARTIAL_NOTICE,
  TRIAGE_CLOSED_PR_NOTICE,
  TRIAGE_PREVIEW_SENTINEL,
  TRIAGE_PUBLISH_LENS,
  TRIAGE_STALE_HEAD_NOTICE,
  TRIAGE_SUMMARY_SENTINEL,
  TRIAGE_THREAD_RESOLUTION_NOTICE,
} from "../../settings/index.ts";
import {
  assertTriagePullRequestWritable,
  TriageCancelledError,
  TriageClosedPullRequestError,
} from "./triageErrors.ts";
import { loadPrHeadCiState } from "../../state/prHeadCiState.ts";
import { workRunById } from "../../state/workRuns.ts";
import {
  foundFromRecovery,
  intentIdentity,
  operationIntentMarker,
  triagePreviewOperationKey,
  triagePushOperationKey,
  triageReportOperationKey,
  triageThreadOperationKey,
  type FeaturePublication,
} from "../../state/featurePublication.ts";
import { throwIfAborted } from "../../errors/appError.ts";
import {
  StaleHeadPushError,
  type WritablePrCheckout,
} from "../../prWorkspace/writablePrCheckout.ts";
import {
  classifyTriageBulkOutcomes,
  renderTriagePreview,
  renderTriageReport,
  type TriageBulkOutcome,
  type TriagePreviewHunk,
} from "./triageRender.ts";

type TriagePublishCheckout = Pick<
  WritablePrCheckout,
  "headRef" | "push" | "listCommittedShas" | "listCommittedDetails"
>;

type PublishTriageParams = {
  readonly publication: FeaturePublication;
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

export function parseStoredTriagePreviewDetail(detail: unknown) {
  if (!isRecord(detail))
    return ((pinnedReturn: StoredTriagePreviewDetail | null) => pinnedReturn)(null);
  const entry = detail;
  if (typeof entry.headSha !== "string" || entry.headSha.length === 0)
    return ((pinnedReturn: StoredTriagePreviewDetail | null) => pinnedReturn)(null);
  if (!Array.isArray(entry.threadRootCommentIds) || !Array.isArray(entry.hunks))
    return ((pinnedReturn: StoredTriagePreviewDetail | null) => pinnedReturn)(null);
  const payload = v.safeParse(TriagePayloadSchema, entry.payload);
  if (!payload.success)
    return ((pinnedReturn: StoredTriagePreviewDetail | null) => pinnedReturn)(null);
  const threadRootCommentIds: number[] = [];
  for (const id of entry.threadRootCommentIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0)
      return ((pinnedReturn: StoredTriagePreviewDetail | null) => pinnedReturn)(null);
    threadRootCommentIds.push(id);
  }
  const hunks: TriagePreviewHunk[] = [];
  for (const raw of entry.hunks) {
    if (!isRecord(raw))
      return ((pinnedReturn: StoredTriagePreviewDetail | null) => pinnedReturn)(null);
    const hunk = raw;
    if (
      typeof hunk.threadRootCommentId !== "number" ||
      !Number.isInteger(hunk.threadRootCommentId) ||
      hunk.threadRootCommentId <= 0 ||
      typeof hunk.subject !== "string" ||
      typeof hunk.diff !== "string"
    ) {
      return ((pinnedReturn: StoredTriagePreviewDetail | null) => pinnedReturn)(null);
    }
    hunks.push({
      threadRootCommentId: hunk.threadRootCommentId,
      subject: hunk.subject,
      diff: hunk.diff,
    });
  }
  return ((pinnedReturn: StoredTriagePreviewDetail | null) => pinnedReturn)({
    headSha: entry.headSha,
    threadRootCommentIds,
    hunks,
    payload: payload.output,
  });
}

function parseStoredCommit(value: unknown) {
  if (!isRecord(value)) return ((pinnedReturn: TriageCommittedDetail | null) => pinnedReturn)(null);
  const entry = value;
  return ((pinnedReturn: TriageCommittedDetail | null) => pinnedReturn)(
    typeof entry.sha === "string" &&
      typeof entry.subject === "string" &&
      typeof entry.diff === "string"
      ? { sha: entry.sha, subject: entry.subject, diff: entry.diff }
      : null,
  );
}

function inferStoredPushOutcome(
  entry: Record<string, unknown>,
  commits: readonly TriageCommittedDetail[],
) {
  if (isTriagePushOutcome(entry.pushOutcome))
    return ((pinnedReturn: TriagePushOutcome) => pinnedReturn)(entry.pushOutcome);
  if (entry.staleHead === true) return ((pinnedReturn: TriagePushOutcome) => pinnedReturn)("stale");
  return ((pinnedReturn: TriagePushOutcome) => pinnedReturn)(
    commits.length > 0 ? "pushed" : "not-needed",
  );
}

export function parseStoredTriagePushDetail(detail: unknown) {
  if (!isRecord(detail))
    return ((pinnedReturn: StoredTriagePushDetail | null) => pinnedReturn)(null);
  const entry = detail;
  const payload = v.safeParse(TriagePayloadSchema, entry.payload);
  if (!payload.success || !Array.isArray(entry.commits))
    return ((pinnedReturn: StoredTriagePushDetail | null) => pinnedReturn)(null);
  const parsedCommits: TriageCommittedDetail[] = [];
  for (const raw of entry.commits) {
    const commit = parseStoredCommit(raw);
    if (commit === null)
      return ((pinnedReturn: StoredTriagePushDetail | null) => pinnedReturn)(null);
    parsedCommits.push(commit);
  }
  return ((pinnedReturn: StoredTriagePushDetail | null) => pinnedReturn)({
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
  });
}

function storedTriagePushRecord(params: {
  readonly outcome: TriagePushOutcome;
  readonly headRef: string;
  readonly headSha: string;
  readonly committedShas: readonly string[];
  readonly commits: readonly TriageCommittedDetail[];
  readonly payload: TriagePayload;
}) {
  const shared = {
    pushOutcome: params.outcome,
    payload: params.payload,
    commits: params.commits,
    baseHeadSha: params.headSha,
    headRef: params.headRef,
  };
  if (params.outcome === "stale" || params.outcome === "closed") {
    return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({
      ...shared,
      ...(params.outcome === "stale" ? { staleHead: true } : {}),
      attemptedShas: params.committedShas,
    });
  }
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({
    ...shared,
    pushedShas: params.committedShas,
    pushedHeadSha: params.committedShas.at(-1) ?? params.headSha,
  });
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

function shouldResolveTriageThread(verdict: TriageVerdict, pushOutcome: TriagePushOutcome) {
  switch (verdict.verdict) {
    case "skipped":
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
    case "fixed":
      return ((pinnedReturn: boolean) => pinnedReturn)(pushOutcome === "pushed");
    case "already-resolved":
    case "dismissed":
      return ((pinnedReturn: boolean) => pinnedReturn)(true);
    default: {
      const exhaustive: never = verdict;
      return ((pinnedReturn: boolean) => pinnedReturn)(exhaustive);
    }
  }
}

function replyBody(verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>) {
  if (verdict.verdict === "fixed") {
    return ((pinnedReturn: string) => pinnedReturn)(
      redactReviewText(
        `**Triage**: Fixed in ${verdict.commitSha.slice(0, 7)} - ${verdict.evidence}`,
      ),
    );
  }
  return ((pinnedReturn: string) => pinnedReturn)(
    redactReviewText(`**Triage**: Already resolved - ${verdict.evidence}`),
  );
}

async function findMarkedComment(prSurface: PrSurface, marker: string, rootCommentId?: number) {
  const botLogin = await prSurface.getBotLogin();
  const { comments } = await prSurface.listReviewComments();
  const id = findCommentIdByMarker(
    comments,
    marker,
    (comment) =>
      comment.authorLogin === botLogin &&
      (rootCommentId == null || comment.inReplyToId === rootCommentId),
  );
  return ((
    pinnedReturn: ({ readonly id: number } | null) | Promise<{ readonly id: number } | null>,
  ) => pinnedReturn)(id == null ? null : { id });
}

async function replyToThread(
  params: Pick<PublishTriageParams, "prSurface" | "prNumber"> & {
    readonly thread: BotFindingThread;
    readonly verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>;
    readonly operationMarker: string;
    readonly receipt: string;
  },
) {
  await params.prSurface.replyAt(
    {
      kind: "inlineReviewThread",
      prNumber: params.prNumber,
      inReplyToCommentId: params.thread.rootCommentId,
    },
    `${replyBody(params.verdict)}\n${params.operationMarker}${params.receipt}`,
  );
}

async function upsertTriageReport(
  params: Pick<
    PublishTriageParams,
    "prSurface" | "publication" | "workItemId" | "resourceKey" | "signal"
  > & {
    readonly body: string;
  },
) {
  const operationKey = triageReportOperationKey(params.resourceKey);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const result = await params.publication.once({
    decodeResult: decodeProgressComment,
    resourceTarget: "triage_report_comment",
    blocksOverwrite: true,
    operationKey,
    mutationKind: "github.triage_report",
    identity: {
      step: "triage_report",
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      operationMarker,
    },
    recover: () =>
      foundFromRecovery(
        recoverMarkedProgressComment(params.prSurface, {
          operationMarker,
          sentinel: TRIAGE_SUMMARY_SENTINEL,
        }),
      ),
    isKnownNoAcceptanceError: triageNoAcceptance,
    signal: params.signal,
    mutate: async () => {
      await assertTriagePublicationActive(params);
      return params.prSurface.upsertProgressComment(
        `${redactReviewText(params.body)}\n${operationMarker}`,
        TRIAGE_SUMMARY_SENTINEL,
      );
    },
  });
  params.publication.record({
    lens: TRIAGE_PUBLISH_LENS,
    step: "triage_report",
    detail: { updated: result.updated, githubId: result.id },
  });
}

export async function publishTriageReportOnly(params: ReportOnlyParams) {
  await upsertTriageReport(params);
}

type PublishTriagePreviewParams = Omit<
  PublishTriageParams,
  "checkout" | "resolutionByRootCommentId"
> & {
  readonly hunks: readonly TriagePreviewHunk[];
};

export async function publishTriagePreview(params: PublishTriagePreviewParams) {
  const body = renderTriagePreview({
    headSha: params.headSha,
    inventory: params.inventory,
    hunks: params.hunks,
    scope: params.scope,
    threadRootCommentId: params.threadRootCommentId,
  });
  const operationKey = triagePreviewOperationKey(params.resourceKey);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const result = await params.publication.once({
    decodeResult: decodeProgressComment,
    resourceTarget: "triage_preview_comment",
    blocksOverwrite: true,
    operationKey,
    mutationKind: "github.triage_preview",
    identity: {
      step: "triage_preview",
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      operationMarker,
    },
    recover: () =>
      foundFromRecovery(
        recoverMarkedProgressComment(params.prSurface, {
          operationMarker,
          sentinel: TRIAGE_PREVIEW_SENTINEL,
        }),
      ),
    isKnownNoAcceptanceError: triageNoAcceptance,
    mutate: () =>
      params.prSurface.upsertProgressComment(
        `${redactReviewText(body)}\n${operationMarker}`,
        TRIAGE_PREVIEW_SENTINEL,
      ),
  });
  const previewDetail = {
    headSha: params.headSha,
    threadRootCommentIds: params.inventory.map((thread) => thread.rootCommentId),
    hunks: params.hunks,
    payload: params.payload,
  } satisfies StoredTriagePreviewDetail;
  params.publication.record({
    lens: TRIAGE_PUBLISH_LENS,
    step: "triage_preview",
    detail: { ...previewDetail, githubId: result.id },
  });
}

export async function publishTriage(params: PublishTriageParams) {
  return ((pinnedReturn: PublishTriageResult | Promise<PublishTriageResult>) => pinnedReturn)(
    publishTriageBody(params, { kind: "fresh", checkout: params.checkout }),
  );
}

type TriagePublication =
  | { readonly kind: "fresh"; readonly checkout: TriagePublishCheckout }
  | { readonly kind: "retained"; readonly push: StoredTriagePushDetail };

type RecoveryTriageParams = Omit<PublishTriageParams, "checkout" | "payload"> & {
  readonly headRef: string;
  readonly recoveryInventory?: readonly BotFindingThread[];
};

function triageNoAcceptance(error: unknown) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    error instanceof TriageClosedPullRequestError ||
      error instanceof TriageCancelledError ||
      isKnownNoAcceptanceMutationError(error),
  );
}

function triagePushFailClosed(params: { readonly workItemId: string }, operationKey: string) {
  return ((pinnedReturn: AppError) => pinnedReturn)(
    new AppError({
      domain: "operation_intent",
      kind: "mutation_outcome_unknown",
      message:
        "Mutation outcome unknown after crash between mutating and reconciled; remutate forbidden",
      context: { workItemId: params.workItemId, operationKey, unknownResolution: "terminal" },
    }),
  );
}

export async function recoverTriagePublication(params: RecoveryTriageParams) {
  const publication = params.publication;
  const detail =
    publication.completed("triage_push") ??
    publication.latestWithoutNewer(TRIAGE_PUBLISH_LENS, "triage_push", "triage_report");
  const operationKey = triagePushOperationKey(params.resourceKey);
  const intent = detail == null ? publication.intent(operationKey) : undefined;
  const failClosed = () => {
    throw triagePushFailClosed(params, operationKey);
  };
  if (detail == null && intent == null)
    return ((pinnedReturn: (PublishTriageResult | null) | Promise<PublishTriageResult | null>) =>
      pinnedReturn)(null);
  if (intent?.state === "mutation_failed" || intent?.state === "reserved")
    return ((pinnedReturn: (PublishTriageResult | null) | Promise<PublishTriageResult | null>) =>
      pinnedReturn)(null);
  if (intent?.state === "outcome_unknown_terminal") return failClosed();
  const retained = detail ?? intentIdentity(intent).pushPlan;
  const push = parseStoredTriagePushDetail(retained);
  if (push == null || !isRecord(retained)) {
    if (intent != null) return failClosed();
    throw new AppError({
      domain: "triage",
      kind: "invalid_stored_push",
      message: "Stored triage_push detail is invalid",
    });
  }
  if (intent != null) {
    const roots = v.safeParse(
      v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
      retained.threadRootCommentIds,
    );
    const run = workRunById(publication.db, params.workItemId);
    const runPayload: unknown = run === undefined ? undefined : JSON.parse(run.payload_json);
    const runHeadSha =
      isRecord(runPayload) && typeof runPayload.headSha === "string" ? runPayload.headSha : null;
    const verdictIds = new Set(push.payload.verdicts.map((verdict) => verdict.threadRootCommentId));
    if (
      push.pushOutcome !== "pushed" ||
      push.headRef == null ||
      push.pushedShas == null ||
      push.baseHeadSha == null ||
      runHeadSha?.toLowerCase() !== push.baseHeadSha.toLowerCase() ||
      run?.pr_key !== params.resourceKey ||
      run.kind !== "triage" ||
      !roots.success ||
      roots.output.length !== verdictIds.size ||
      new Set(roots.output).size !== verdictIds.size ||
      !roots.output.every((id) => verdictIds.has(id))
    )
      return failClosed();
  }
  const inventory = retainedPublicationInventory(push, params);
  const publicationParams = inventory == null ? null : { ...params, inventory };
  const matches =
    publicationParams != null && storedPushMatchesPublication(push, publicationParams);
  const reconciledHeadMiss =
    intent?.state === "reconciled" &&
    publicationParams != null &&
    !matches &&
    storedPushMatchesPublication(push, publicationParams, { prePushHead: true });
  if (!matches && !reconciledHeadMiss) {
    if (intent != null) return failClosed();
    return ((pinnedReturn: (PublishTriageResult | null) | Promise<PublishTriageResult | null>) =>
      pinnedReturn)(null);
  }
  if (inventory == null)
    return ((pinnedReturn: (PublishTriageResult | null) | Promise<PublishTriageResult | null>) =>
      pinnedReturn)(null);
  await assertTriagePublicationActive(params);
  if (intent != null) {
    const pushVisible = async () => {
      const pushed = await params.prSurface.listPushedCommits();
      const liveHead = await params.prSurface.getHeadSha();
      const branch = pullRequestBranchInfo((await params.prSurface.getHead()).pullRequest);
      await assertTriagePublicationActive(params);
      return (
        branch.sameRepo &&
        branch.headRef === push.headRef &&
        liveHead.toLowerCase() === push.pushedHeadSha?.toLowerCase() &&
        push.commits.every((commit) => pushed.some((entry) => entry.sha === commit.sha))
      );
    };
    try {
      if (intent.state === "reconciled" && intent.result_json === null) {
        if (!(await pushVisible())) {
          throw new AppError({
            domain: "operation_intent",
            kind: "mutation_outcome_unknown",
            message:
              "Reconciled mutation has no stored result and recovery cannot rebuild it; remutate forbidden",
            context: { workItemId: params.workItemId, operationKey, unknownResolution: "terminal" },
          });
        }
      } else {
        await publication.once({
          decodeResult: () => undefined,
          allowsUndefinedResult: true,
          resourceTarget: "triage_push",
          operationKey,
          mutationKind: "github.triage_push",
          signal: params.signal,
          recover: async () =>
            (await pushVisible()) ? { found: true, value: undefined } : { found: false },
          mutate: async () => failClosed(),
        });
      }
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
      publication.record({
        lens: TRIAGE_PUBLISH_LENS,
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
      return ((pinnedReturn: (PublishTriageResult | null) | Promise<PublishTriageResult | null>) =>
        pinnedReturn)(
        publishTriageBody(
          { ...params, inventory, payload: push.payload },
          { kind: "retained", push: closed },
        ),
      );
    }
    publication.record({ lens: TRIAGE_PUBLISH_LENS, step: "triage_push", detail: retained });
  }
  return ((pinnedReturn: (PublishTriageResult | null) | Promise<PublishTriageResult | null>) =>
    pinnedReturn)(
    publishTriageBody({ ...params, inventory, payload: push.payload }, { kind: "retained", push }),
  );
}

function retainedPublicationInventory(push: StoredTriagePushDetail, params: RecoveryTriageParams) {
  if (params.recoveryInventory == null)
    return ((pinnedReturn: readonly BotFindingThread[] | null) => pinnedReturn)(params.inventory);
  const ids = new Set(push.payload.verdicts.map((verdict) => verdict.threadRootCommentId));
  if (params.inventory.some((thread) => !ids.has(thread.rootCommentId)))
    return ((pinnedReturn: readonly BotFindingThread[] | null) => pinnedReturn)(null);
  const inventory = params.recoveryInventory.filter((thread) => ids.has(thread.rootCommentId));
  const unresolvedIds = new Set(params.inventory.map((thread) => thread.rootCommentId));
  if (
    inventory.some(
      (thread) =>
        !unresolvedIds.has(thread.rootCommentId) &&
        params.resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved !== true,
    )
  )
    return ((pinnedReturn: readonly BotFindingThread[] | null) => pinnedReturn)(null);
  return ((pinnedReturn: readonly BotFindingThread[] | null) => pinnedReturn)(inventory);
}

function storedPushMatchesPublication(
  push: StoredTriagePushDetail,
  params: RecoveryTriageParams,
  options?: { readonly prePushHead?: boolean },
) {
  if (push.pushOutcome === "stale" || push.pushOutcome === "closed")
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (!options?.prePushHead && push.pushedHeadSha?.toLowerCase() !== params.headSha.toLowerCase())
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (push.headRef != null && push.headRef !== params.headRef)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const verdictIds = new Set(push.payload.verdicts.map((verdict) => verdict.threadRootCommentId));
  if (
    verdictIds.size !== params.inventory.length ||
    !params.inventory.every((thread) => verdictIds.has(thread.rootCommentId))
  )
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const shas = push.commits.map((commit) => commit.sha);
  if (
    push.pushedShas != null &&
    (push.pushedShas.length !== shas.length ||
      !push.pushedShas.every((sha, index) => sha === shas[index]))
  )
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (push.pushOutcome === "pushed" && (shas.length === 0 || shas.at(-1) !== push.pushedHeadSha))
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    push.pushOutcome !== "pushed" ||
      !push.payload.verdicts.some(
        (verdict) => verdict.verdict === "fixed" && !shas.includes(verdict.commitSha),
      ),
  );
}

async function assertTriagePublicationActive(
  params: Pick<PublishTriageParams, "publication" | "workItemId" | "signal">,
) {
  throwIfAborted(params.signal, {
    message: "PR-surface mutation was aborted before completion",
    context: { workItemId: params.workItemId },
  });
  if (!params.publication.current()) throw new TriageCancelledError();
}

async function assertTriageWriteAllowed(
  params: Pick<PublishTriageParams, "publication" | "workItemId" | "signal" | "prSurface">,
) {
  await assertTriagePublicationActive(params);
  await assertTriagePullRequestWritable(params.prSurface);
}

async function publishTriageBody(
  params: Omit<PublishTriageParams, "checkout">,
  publication: TriagePublication,
) {
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
      const retained = params.publication.intent(operationKey);
      if (
        retained != null &&
        retained.state !== "reserved" &&
        retained.state !== "mutation_failed" &&
        !isDeepStrictEqual(intentIdentity(retained).pushPlan, pushPlan)
      ) {
        throw triagePushFailClosed(params, operationKey);
      }
      await params.publication.once({
        decodeResult: () => undefined,
        allowsUndefinedResult: true,
        resourceTarget: "triage_push",
        signal: params.signal,
        operationKey,
        mutationKind: "github.triage_push",
        identity: {
          step: "triage_push",
          resourceKey: params.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
          pushPlan,
        },
        recover: async (intent) => {
          const plan = parseStoredTriagePushDetail(intentIdentity(intent).pushPlan);
          if (plan == null) return { found: false };
          const pushed = await params.prSurface.listPushedCommits();
          const liveHead = await params.prSurface.getHeadSha();
          const branch = pullRequestBranchInfo((await params.prSurface.getHead()).pullRequest);
          await assertTriagePublicationActive(params);
          return branch.sameRepo &&
            branch.headRef === plan.headRef &&
            liveHead.toLowerCase() === plan.pushedHeadSha?.toLowerCase() &&
            plan.commits.every((expected) => pushed.some((commit) => commit.sha === expected.sha))
            ? { found: true, value: undefined }
            : { found: false };
        },
        isKnownNoAcceptanceError: (error) =>
          error instanceof StaleHeadPushError || triageNoAcceptance(error),
        mutate: async () => {
          await assertTriageWriteAllowed(params);
          await publication.checkout.push();
        },
      });
      await assertTriagePublicationActive(params);
      await assertTriagePullRequestWritable(params.prSurface);
      pushOutcome = "pushed";
      params.publication.record({
        lens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: storedTriagePushRecord({
          outcome: "pushed",
          headSha: params.headSha,
          headRef: publication.checkout.headRef,
          committedShas,
          commits: committedDetails,
          payload: params.payload,
        }),
      });
    } catch (error) {
      if (error instanceof TriageClosedPullRequestError) {
        pushOutcome = "closed";
      } else if (error instanceof StaleHeadPushError) {
        pushOutcome = "stale";
      } else {
        throw error;
      }
      params.publication.record({
        lens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: storedTriagePushRecord({
          outcome: pushOutcome,
          headSha: params.headSha,
          headRef: publication.checkout.headRef,
          committedShas,
          commits: committedDetails,
          payload: params.payload,
        }),
      });
    }
  } else if (publication.kind === "fresh") {
    params.publication.record({
      lens: TRIAGE_PUBLISH_LENS,
      step: "triage_push",
      detail: storedTriagePushRecord({
        outcome: "not-needed",
        headSha: params.headSha,
        headRef: publication.checkout.headRef,
        committedShas: [],
        commits: [],
        payload: params.payload,
      }),
    });
  }

  const storedActed = params.publication.completed("triage_thread_actions")?.actedThreadIds;
  const actedThreadIds = new Set(
    Array.isArray(storedActed)
      ? storedActed.filter((id): id is number => Number.isInteger(id))
      : [],
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
    const findingId = thread.findingId;
    if (findingId == null) {
      missingThreadAction = true;
      continue;
    }
    {
      if (
        shouldReplyToTriageThread(verdict) &&
        !actedThreadIds.has(verdict.threadRootCommentId) &&
        thread.hasTriageReply !== true
      ) {
        const receipt = await unpostedResolutionReceipt(params.prSurface, {
          threadNodeId: resolution.threadNodeId,
          findingId,
          kind: "fixed",
        });
        const operationKey = triageThreadOperationKey(verdict.threadRootCommentId);
        const operationMarker = operationIntentMarker(operationKey, params.workItemId);
        await params.publication.once({
          decodeResult: () => undefined,
          allowsUndefinedResult: true,
          resourceTarget: `thread_reply:${verdict.threadRootCommentId}`,
          signal: params.signal,
          operationKey,
          mutationKind: "github.triage_thread_reply",
          identity: {
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
            return existing == null ? { found: false } : { found: true, value: undefined };
          },
          isKnownNoAcceptanceError: triageNoAcceptance,
          mutate: async () => {
            await assertTriagePublicationActive(params);
            if (receipt == null) return;
            await replyToThread({
              ...params,
              thread,
              verdict,
              operationMarker,
              receipt,
            });
          },
        });
        actedThreadIds.add(verdict.threadRootCommentId);
        params.publication.record({
          lens: TRIAGE_PUBLISH_LENS,
          step: "triage_thread_actions",
          detail: { actedThreadIds: [...actedThreadIds] },
        });
      }
      const operationKey = `${triageThreadOperationKey(verdict.threadRootCommentId)}:resolve`;
      await params.publication.once({
        decodeResult: () => undefined,
        allowsUndefinedResult: true,
        resourceTarget: `thread_resolve:${verdict.threadRootCommentId}`,
        signal: params.signal,
        operationKey,
        mutationKind: "github.triage_thread_resolve",
        identity: {
          step: "triage_thread_actions",
          resourceKey: params.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
          threadRootCommentId: verdict.threadRootCommentId,
        },
        recover: async () => {
          const current = await params.prSurface.listInlineReviewThreads();
          return current.byRootCommentId.get(verdict.threadRootCommentId)?.isResolved === true
            ? { found: true, value: undefined }
            : { found: false };
        },
        isKnownNoAcceptanceError: triageNoAcceptance,
        mutate: async () => {
          await assertTriagePublicationActive(params);
          if (verdict.verdict === "dismissed") {
            await appendRootResolutionReceipt(params.prSurface, {
              threadNodeId: resolution.threadNodeId,
              findingId,
              kind: "dismissed",
            });
          }
          await params.prSurface.resolveInlineReviewThread(resolution.threadNodeId);
        },
      });
    }
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
  const ciRow = loadPrHeadCiState(params.publication.db, {
    repoKey: `${params.owner}/${params.repo}`,
    headSha: ciHeadSha,
  });

  await assertTriagePublicationActive(params);
  await upsertTriageReport({
    ...params,
    body: renderTriageReport({
      headSha: params.headSha,
      ciRollup: {
        headSha: ciHeadSha,
        version: ciRow?.state.version ?? 0,
        rollup: ciRow?.state.rollup ?? "none",
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

  return ((pinnedReturn: PublishTriageResult | Promise<PublishTriageResult>) => pinnedReturn)({
    pushOutcome,
    missingThreadAction,
    ...(partialBulk ? { partialBulk: true } : {}),
  });
}
