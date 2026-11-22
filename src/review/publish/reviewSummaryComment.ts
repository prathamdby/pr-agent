import {
  claimPublishStep,
  ensureRediscoveredSummaryComment,
  latestCommentGithubId,
  sharedPublishRecord,
  writePublishStep,
  type PublishDb,
} from "../../state/publish.ts";
import { logWarn } from "../../evlog.ts";
import type { IssueCommentRef, PrSurface } from "../../github/prSurface.ts";
import {
  REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS,
  type AnyReviewLens,
} from "../../settings/index.ts";
import { parseProgressRevisionState, withProgressRevisionComment } from "../run/commentMarkers.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.ts";
import type {
  InstallationOperation,
  ReviewCapabilityPolicy,
} from "../../github/installationCapabilities.ts";
import type { ReviewPublishTarget } from "./reviewPublishSession.ts";

function capabilityNotice(policy: ReviewCapabilityPolicy | undefined) {
  if (!policy) return ((pinnedReturn: string | null) => pinnedReturn)(null);
  const unavailable = (operation: InstallationOperation) =>
    policy.access(operation) !== "available";
  const surfaces: string[] = [];
  for (const [name, read, write] of [
    ["Checks", "checksRead", "checksWrite"],
    ["commit statuses", "statusesRead", "statusesWrite"],
  ] as const) {
    const missingRead = unavailable(read);
    const missingWrite = unavailable(write);
    if (missingRead || missingWrite) {
      surfaces.push(
        `${name} ${missingRead && missingWrite ? "read/write" : missingRead ? "read" : "write"}`,
      );
    }
  }
  if (unavailable("actionsRead")) surfaces.push("Actions logs");
  if (unavailable("labelsRead") || unavailable("labelsWrite")) surfaces.push("labels");
  if (unavailable("reactionsWrite")) surfaces.push("reactions");
  if (!surfaces.length) return ((pinnedReturn: string | null) => pinnedReturn)(null);
  return ((pinnedReturn: string | null) => pinnedReturn)(
    [
      "<details>",
      "<summary>Limited permissions</summary>",
      "",
      "Unavailable for this review:",
      "",
      ...surfaces.map((surface) => `- ${surface}`),
      "",
      "</details>",
    ].join("\n"),
  );
}

export type SummaryCommentCoordination = ReviewPublishTarget;

export function upsertSummaryProgressComment(
  prSurface: PrSurface,
  body: string,
  sentinel: string,
  known: IssueCommentRef | null,
) {
  return prSurface.upsertProgressComment(body, sentinel, known);
}

export type RecordPublishStepFn = (
  step: "inline_review" | "summary_comment" | "labels",
  detail?: { githubId?: string | number; meta?: Record<string, unknown> },
) => Promise<void>;

export type RecordPublishStepWithCoordination = RecordPublishStepFn & {
  summaryCommentCoordination?: SummaryCommentCoordination;
};

export function attachSummaryCommentCoordination(
  recordPublishStep: RecordPublishStepFn,
  coordination: SummaryCommentCoordination,
) {
  return ((pinnedReturn: RecordPublishStepWithCoordination) => pinnedReturn)(
    Object.assign(recordPublishStep, { summaryCommentCoordination: coordination }),
  );
}

export function recordPublishStepFor(
  coordination: SummaryCommentCoordination,
  reviewLens: AnyReviewLens,
) {
  return attachSummaryCommentCoordination(async (step, detail) => {
    writePublishStep(coordination.db, {
      workId: coordination.workItemId,
      prKey: coordination.resourceKey,
      reviewLens,
      step,
      ...(detail?.githubId !== undefined ? { githubId: detail.githubId } : {}),
      ...(detail?.meta !== undefined
        ? { detail: step === "inline_review" ? { batches: [detail.meta] } : detail.meta }
        : {}),
    });
  }, coordination);
}

async function resolveKnownSummaryCommentRef(
  prSurface: PrSurface,
  sentinel: string,
  hintCommentId: number | null | undefined,
) {
  const resolved = await prSurface.resolveProgressComment(sentinel, hintCommentId);
  return ((pinnedReturn: { id: number; url: string } | null) => pinnedReturn)(
    resolved ? { id: resolved.id, url: resolved.url } : null,
  );
}

type ProgressCommentRevision = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type TickRevision = Exclude<ProgressCommentRevision, 7>;

type SummaryCommentUpsertResult = {
  readonly id: number;
  readonly updated: boolean;
  readonly skipped?: true;
};

type SummaryCommentUpsertParams = {
  readonly coordination: SummaryCommentCoordination;
  readonly reviewLens: AnyReviewLens;
  readonly prSurface: PrSurface;
  readonly body: string;
  readonly sentinel: string;
  readonly hintCommentId?: number | null;
  readonly progressRevision: ProgressCommentRevision;
  readonly ciHeadSha?: string;
  readonly ciVersion?: number;
  readonly shouldPublish?: (db: PublishDb) => Promise<boolean>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function upsertSummaryCommentWithoutRevision(
  params: SummaryCommentUpsertParams & { readonly body: string },
) {
  const { coordination, reviewLens, prSurface, body, sentinel } = params;
  const storedId =
    latestCommentGithubId(coordination.db, coordination.resourceKey, reviewLens) ??
    (await ensureRediscoveredSummaryComment(coordination.db, prSurface, {
      workId: coordination.workItemId,
      prKey: coordination.resourceKey,
      reviewLens,
      sentinel,
    }));
  const hintId = params.hintCommentId ?? storedId ?? null;
  const knownFromStored = await resolveKnownSummaryCommentRef(prSurface, sentinel, hintId);
  if (knownFromStored)
    return ((pinnedReturn: Promise<SummaryCommentUpsertResult>) => pinnedReturn)(
      prSurface.upsertProgressComment(body, sentinel, knownFromStored),
    );
  const claimWon = claimPublishStep(coordination.db, {
    workId: coordination.workItemId,
    prKey: coordination.resourceKey,
    reviewLens,
    step: "summary_comment_claim",
  });
  if (!claimWon) {
    for (const delay of [0, ...REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS.slice(0, 2)]) {
      if (delay > 0) await sleep(delay);
      const polledId = latestCommentGithubId(coordination.db, coordination.resourceKey, reviewLens);
      if (polledId == null) continue;
      const known = await resolveKnownSummaryCommentRef(prSurface, sentinel, polledId);
      if (known)
        return ((pinnedReturn: Promise<SummaryCommentUpsertResult>) => pinnedReturn)(
          prSurface.upsertProgressComment(body, sentinel, known),
        );
    }
  }
  const scanned = await prSurface.findProgressComment(sentinel);
  return ((pinnedReturn: Promise<SummaryCommentUpsertResult>) => pinnedReturn)(
    prSurface.upsertProgressComment(body, sentinel, scanned),
  );
}

function skippedRevisionResult(
  currentComment: IssueCommentRef | null,
  hintCommentId?: number | null,
) {
  return ((pinnedReturn: SummaryCommentUpsertResult) => pinnedReturn)({
    id: currentComment?.id ?? hintCommentId ?? 0,
    updated: false,
    skipped: true,
  });
}

function numberDetail(detail: Record<string, unknown> | undefined, key: string) {
  const value = detail?.[key];
  return ((pinnedReturn: number | null) => pinnedReturn)(
    typeof value === "number" && Number.isFinite(value) ? value : null,
  );
}

async function upsertSummaryCommentAtRevision(params: SummaryCommentUpsertParams) {
  const { coordination, reviewLens } = params;
  const workItemId = coordination.workItemId;
  const currentComment = await params.prSurface.findProgressComment(params.sentinel);
  const progress = sharedPublishRecord(
    coordination.db,
    coordination.resourceKey,
    reviewLens,
    "progress_comment",
  );
  if (params.shouldPublish && !(await params.shouldPublish(coordination.db)))
    return skippedRevisionResult(currentComment, params.hintCommentId);
  if (progress !== undefined && progress.workId !== workItemId) {
    if (params.progressRevision > 0 || (currentComment == null && params.hintCommentId == null)) {
      logWarn("review_progress_skipped_foreign_owner", {
        resourceKey: coordination.resourceKey,
        reviewLens,
        workItemId,
        ownerWorkItemId: progress.workId,
        progressGeneration: numberDetail(progress.detail, "progressGeneration") ?? 0,
        progressRevision: params.progressRevision,
      });
    }
    return skippedRevisionResult(currentComment, params.hintCommentId);
  }
  const storedRevision = numberDetail(progress?.detail, "progressRevision") ?? -1;
  const bodyRevision = currentComment
    ? parseProgressRevisionState(currentComment.body ?? "")
    : null;
  const bodyRevisionForRun =
    bodyRevision != null && bodyRevision.workItemId === workItemId ? bodyRevision.revision : -1;
  if (currentComment && bodyRevisionForRun >= params.progressRevision)
    return ((pinnedReturn: SummaryCommentUpsertResult) => pinnedReturn)({
      id: currentComment.id,
      updated: false,
      skipped: true,
    });
  if (storedRevision > params.progressRevision)
    return skippedRevisionResult(currentComment, params.hintCommentId);
  const stubPostedAtMs = numberDetail(progress?.detail, "stubPostedAtMs") ?? Date.now();
  const progressDetail = {
    progressRevision: params.progressRevision,
    ...(stubPostedAtMs != null ? { stubPostedAtMs } : {}),
    ...(params.ciHeadSha != null
      ? { headSha: params.ciHeadSha, version: params.ciVersion ?? 0 }
      : {}),
  };
  writePublishStep(coordination.db, {
    workId: workItemId,
    prKey: coordination.resourceKey,
    reviewLens,
    step: "progress_comment",
    detail: progressDetail,
  });
  const result = await upsertSummaryCommentWithoutRevision({
    ...params,
    body: withProgressRevisionComment(params.body, params.progressRevision, workItemId),
    hintCommentId: currentComment?.id ?? params.hintCommentId,
  });
  writePublishStep(coordination.db, {
    workId: workItemId,
    prKey: coordination.resourceKey,
    reviewLens,
    step: "progress_comment",
    githubId: result.id,
    detail: { ...progressDetail, updated: result.updated },
  });
  return ((pinnedReturn: SummaryCommentUpsertResult) => pinnedReturn)(result);
}

export type ReviewSummaryCommentDeps = {
  readonly prSurface: PrSurface;
  readonly reviewLens: AnyReviewLens;
  readonly coordination?: SummaryCommentCoordination;
};

type ReviewSummaryCommentWrite = {
  readonly body: string;
  readonly hintCommentId?: number | null;
  readonly ciHeadSha?: string;
  readonly ciVersion?: number;
  readonly knownExisting?: IssueCommentRef | null;
};

export type ReviewSummaryCommentTick = ReviewSummaryCommentWrite & {
  readonly progressRevision: TickRevision;
  readonly shouldPublish?: (db: PublishDb) => Promise<boolean>;
};

export type ReviewSummaryCommentWriter = {
  readonly tick: (params: ReviewSummaryCommentTick) => Promise<SummaryCommentUpsertResult>;
  readonly conclude: (params: ReviewSummaryCommentWrite) => Promise<SummaryCommentUpsertResult>;
};

export function createReviewSummaryComment(deps: ReviewSummaryCommentDeps) {
  const write = async (
    params: ReviewSummaryCommentWrite & {
      readonly shouldPublish?: ReviewSummaryCommentTick["shouldPublish"];
    },
    progressRevision: ProgressCommentRevision,
  ) => {
    const coordination = deps.coordination;
    const notice = capabilityNotice(deps.prSurface.capabilities);
    const body = notice == null ? params.body : `${params.body}\n\n${notice}`;
    if (coordination == null)
      return deps.prSurface.upsertProgressComment(
        body,
        REVIEW_SUMMARY_SENTINEL,
        params.knownExisting ?? null,
      );
    return upsertSummaryCommentAtRevision({
      coordination,
      reviewLens: deps.reviewLens,
      prSurface: deps.prSurface,
      body,
      sentinel: REVIEW_SUMMARY_SENTINEL,
      hintCommentId: params.hintCommentId,
      progressRevision,
      ...(params.ciHeadSha !== undefined ? { ciHeadSha: params.ciHeadSha } : {}),
      ...(params.ciVersion !== undefined ? { ciVersion: params.ciVersion } : {}),
      ...(params.shouldPublish !== undefined ? { shouldPublish: params.shouldPublish } : {}),
    });
  };
  return ((pinnedReturn: ReviewSummaryCommentWriter) => pinnedReturn)({
    tick: (params) => write(params, params.progressRevision),
    conclude: (params) => write(params, 7),
  });
}
