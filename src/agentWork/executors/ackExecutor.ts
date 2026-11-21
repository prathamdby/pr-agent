import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import type { InstallationSurface } from "../installationSurface.ts";
import {
  type Config,
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
  LEGACY_REVIEW_LENSES,
  normalizeReviewLens,
  triageCancelledNotice,
} from "../../settings/index.ts";
import { logWarn } from "../../evlog.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../../review/reviewSchema.ts";
import { parseProgressRevisionState } from "../../review/run/commentMarkers.ts";
import {
  renderReviewCancelledNotice,
  renderReviewAwaitingApprovalNotice,
  renderReviewProgressComment,
} from "../../review/run/progressComment.ts";
import type { ReviewMode } from "../../review/reviewSchema.ts";
import { prResourceKey, type AckJobData } from "../types.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import {
  approvalNoticePublishable,
  progressCommentOwner,
  reviewQueuePosition,
  workRunStatus,
  type FeaturePublication,
} from "../../state/featurePublication.ts";
import { WORK_RUN_ACTIVE_STATUSES } from "../../state/workRuns.ts";
import { loadRenderableHeadCi, requestHeadCiProjection } from "../../state/prHeadCiState.ts";
import {
  canWrite,
  passthroughMutationBoundary,
  publishReactions,
  resolveInstallationPolicy,
} from "./featureCapabilities.ts";
import type { ReviewSurfacePublisher } from "./featureExecution.ts";

const positiveInt = v.pipe(v.number(), v.integer(), v.gtValue(0));

const ackTargetSchema = v.variant("kind", [
  v.object({ kind: v.literal("pr"), prNumber: positiveInt }),
  v.object({ kind: v.literal("issueComment"), commentId: positiveInt }),
  v.object({ kind: v.literal("reviewComment"), commentId: positiveInt }),
]);

const replyTargetSchema = v.variant("kind", [
  v.object({ kind: v.literal("prConversation"), prNumber: positiveInt }),
  v.object({
    kind: v.literal("inlineReviewThread"),
    prNumber: positiveInt,
    inReplyToCommentId: positiveInt,
  }),
]);

const attributionSchema = v.variant("kind", [
  v.object({ kind: v.literal("user"), login: v.string() }),
  v.object({ kind: v.literal("merged") }),
  v.object({ kind: v.literal("closed") }),
]);

const reviewModeSchema = v.pipe(
  v.picklist(["review", ...LEGACY_REVIEW_LENSES]),
  v.transform(normalizeReviewLens),
);

export const ackPayloadSchema = v.object({
  kind: v.literal("ack"),
  workItemId: v.optional(v.string()),
  installationId: v.number(),
  owner: v.string(),
  repo: v.string(),
  prNumber: v.number(),
  targets: v.array(ackTargetSchema),
  awaitingApproval: v.optional(v.literal(true)),
  awaitingApprovalMaintainerOnly: v.optional(v.literal(true)),
  closedApproval: v.optional(attributionSchema),
  progress: v.optional(
    v.object({
      lens: reviewModeSchema,
      headSha: v.string(),
      source: v.picklist(["auto", "slash"]),
    }),
  ),
  cancelProgress: v.optional(
    v.object({
      workItemId: v.string(),
      cancelledWorkItemIds: v.optional(v.array(v.string())),
      attribution: attributionSchema,
    }),
  ),
  cancelTriage: v.optional(
    v.object({
      workItemId: v.string(),
      cancelledWorkItemIds: v.optional(v.array(v.string())),
      attribution: attributionSchema,
      targets: v.array(ackTargetSchema),
      replyTarget: replyTargetSchema,
    }),
  ),
  reply: v.optional(v.object({ target: replyTargetSchema, body: v.string() })),
  commenterId: v.optional(v.number()),
  webhookEventId: v.optional(v.string()),
  delivery: v.optional(v.string()),
});

export function parseAckPayload(payloadJson: string) {
  return ((pinnedReturn: AckJobData) => pinnedReturn)(
    v.parse(ackPayloadSchema, JSON.parse(payloadJson)),
  );
}

export type AckDependencies = {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly installationSurface: InstallationSurface;
  readonly publication: FeaturePublication;
  readonly reviewPublisher?: ReviewSurfacePublisher;
  readonly now: () => number;
};

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(WORK_RUN_ACTIVE_STATUSES);

export function canAckPublishProgress(
  db: DatabaseSync,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly reviewLens: ReviewMode;
  },
) {
  const status = workRunStatus(db, params.workItemId);
  if (status === undefined || !ACTIVE_STATUSES.has(status)) {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  const owner = progressCommentOwner(db, params.resourceKey, params.reviewLens);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    owner == null || owner.workId === params.workItemId,
  );
}

function reviewPublisherMissing(step: string, resourceKey: string) {
  logWarn("ack_review_publisher_unavailable", { step, resourceKey });
}

async function publishAckProgress(
  deps: AckDependencies,
  data: AckJobData & { readonly progress: NonNullable<AckJobData["progress"]> },
  prSurface: PrSurface,
  resourceKey: string,
) {
  if (!canWrite(prSurface, "commentsWrite")) return;
  const deferredHead = data.progress.headSha === DEFERRED_HEAD_SHA;
  const headSha = deferredHead ? await prSurface.getHeadSha() : data.progress.headSha;
  const rendered = loadRenderableHeadCi(deps.db, {
    owner: data.owner,
    repo: data.repo,
    headSha,
    installationId: data.installationId,
  });
  let queuePosition: { readonly position: number; readonly total: number } | null = null;
  if (data.workItemId != null) {
    try {
      queuePosition = reviewQueuePosition(deps.db, data.workItemId);
    } catch (e) {
      logWarn("ack_queue_position_failed", {
        workItemId: data.workItemId,
        message: errorMessage(e),
      });
    }
  }
  const body = renderReviewProgressComment({
    mode: data.progress.lens,
    headSha,
    source: data.progress.source,
    ciSummary: rendered.summary,
    ciVersion: rendered.version,
    queuePosition,
    progressRevision: 0,
    progressWorkItemId: data.workItemId,
  });
  if (deps.reviewPublisher === undefined) reviewPublisherMissing("progress", resourceKey);
  await deps.reviewPublisher?.tickProgressSummary({
    publication: deps.publication,
    prSurface,
    resourceKey,
    reviewLens: data.progress.lens,
    ...(data.workItemId != null ? { workItemId: data.workItemId } : {}),
    body,
    progressRevision: 0,
    ciHeadSha: headSha,
    ciVersion: rendered.version,
  });
  requestHeadCiProjection(
    deps.db,
    { installationId: data.installationId, owner: data.owner, repo: data.repo, headSha },
    { kind: "when_due", renderedVersion: rendered.version },
    deps.now(),
  );
  if (data.workItemId && !deferredHead) {
    await deps.reviewPublisher?.pendingVerdict({
      publication: deps.publication,
      prSurface,
      owner: data.owner,
      repo: data.repo,
      prNumber: data.prNumber,
      commitStatusEnabled: deps.cfg.features.commitStatus,
      headSha,
      workItemId: data.workItemId,
      resourceKey,
      reviewLens: data.progress.lens,
    });
  }
}

async function publishCancelProgress(
  deps: AckDependencies,
  data: AckJobData & { readonly cancelProgress: NonNullable<AckJobData["cancelProgress"]> },
  prSurface: PrSurface,
  resourceKey: string,
) {
  const commentsAvailable = canWrite(prSurface, "commentsWrite");
  const existing = commentsAvailable
    ? await prSurface.findProgressComment(REVIEW_SUMMARY_SENTINEL)
    : null;
  const rev = existing?.body != null ? parseProgressRevisionState(existing.body) : null;
  const ownsStub =
    existing != null &&
    (rev?.workItemId == null || rev.workItemId === data.cancelProgress.workItemId);
  const body = renderReviewCancelledNotice({
    attribution: data.cancelProgress.attribution,
    progressRevision: ownsStub ? (rev?.revision ?? 0) : 0,
    progressWorkItemId: data.cancelProgress.workItemId,
  });

  try {
    if (!commentsAvailable) {
    } else if (ownsStub && existing != null) {
      await deps.publication.once({
        decodeResult: () => undefined,
        allowsUndefinedResult: true,
        resourceTarget: `comment:${existing.id}`,
        blocksOverwrite: true,
        operationKey: `ack:cancel_progress:${existing.id}`,
        mutationKind: "github.progress_comment_edit",
        mutate: () => prSurface.editComment(existing.id, body),
      });
    } else {
      if (deps.reviewPublisher === undefined) reviewPublisherMissing("cancel", resourceKey);
      await deps.reviewPublisher?.tickProgressSummary({
        publication: deps.publication,
        prSurface,
        resourceKey,
        reviewLens: "review",
        workItemId: data.cancelProgress.workItemId,
        body,
        progressRevision: 0,
      });
    }
  } catch (error) {
    logWarn("ack_cancel_comment_failed", {
      workItemId: data.cancelProgress.workItemId,
      resourceKey,
      message: errorMessage(error),
    });
  }

  await deps.reviewPublisher?.closeCancelledVerdicts({
    publication: deps.publication,
    prSurface,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    commitStatusEnabled: deps.cfg.features.commitStatus,
    workItemIds: data.cancelProgress.cancelledWorkItemIds ?? [data.cancelProgress.workItemId],
  });
}

async function publishTriageCancellation(
  deps: AckDependencies,
  prSurface: PrSurface,
  data: AckJobData & { readonly cancelTriage: NonNullable<AckJobData["cancelTriage"]> },
) {
  await publishReactions({
    publication: deps.publication,
    prSurface,
    targets: data.cancelTriage.targets,
    content: GITHUB_REACTION_MINUS_ONE,
    logEvent: "ack_reaction_failed",
  });
  if (canWrite(prSurface, "commentsWrite")) {
    await deps.publication.once({
      decodeResult: () => undefined,
      allowsUndefinedResult: true,
      resourceTarget: `triage_cancel_reply:${data.cancelTriage.workItemId}`,
      operationKey: `ack:triage_cancel_reply:${data.cancelTriage.workItemId}`,
      mutationKind: "github.triage_cancel_reply",
      mutate: async () => {
        await prSurface.replyAt(
          data.cancelTriage.replyTarget,
          triageCancelledNotice(data.cancelTriage.attribution),
        );
      },
    });
  }
}

export async function runAckJob(deps: AckDependencies, data: AckJobData) {
  const { cfg, db } = deps;
  try {
    const bot = await deps.installationSurface.botIdentity(cfg);
    if (data.commenterId != null && bot.userId === data.commenterId) return;
  } catch (e) {
    logWarn("ack_bot_identity_check_failed", {
      message: errorMessage(e),
    });
  }
  const scope = { installationId: data.installationId, owner: data.owner, repo: data.repo };
  const policy = await resolveInstallationPolicy({
    db,
    cfg,
    installationSurface: deps.installationSurface,
    scope,
    now: deps.now,
  });
  if (policy.preflighted && policy.installation === undefined) return;
  const prSurface = await deps.installationSurface.create({
    cfg,
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    installation: policy.installation,
    capabilities: policy.capabilities,
    mutationBoundary: passthroughMutationBoundary(),
  });
  const resourceKey = prResourceKey(data.owner, data.repo, data.prNumber);

  if (!data.awaitingApproval && !data.closedApproval) {
    await publishReactions({
      publication: deps.publication,
      prSurface,
      targets: data.targets,
      content: GITHUB_REACTION_EYES,
      logEvent: "ack_reaction_failed",
    });
  }

  if ((data.awaitingApproval || data.closedApproval) && canWrite(prSurface, "commentsWrite")) {
    if (deps.reviewPublisher === undefined) reviewPublisherMissing("approval", resourceKey);
    await deps.reviewPublisher?.tickProgressSummary({
      publication: deps.publication,
      prSurface,
      resourceKey,
      reviewLens: "review",
      body: data.closedApproval
        ? renderReviewCancelledNotice({ attribution: data.closedApproval, progressRevision: 1 })
        : renderReviewAwaitingApprovalNotice(data.awaitingApprovalMaintainerOnly === true),
      progressRevision: data.closedApproval ? 1 : 0,
      shouldPublish: () =>
        approvalNoticePublishable(db, resourceKey, data.closedApproval ? "withdrawn" : "awaiting"),
    });
  }

  if (data.cancelProgress) {
    try {
      await publishCancelProgress(
        deps,
        { ...data, cancelProgress: data.cancelProgress },
        prSurface,
        resourceKey,
      );
    } catch (error) {
      logWarn("ack_cancel_progress_failed", {
        workItemId: data.cancelProgress.workItemId,
        resourceKey,
        message: errorMessage(error),
      });
    }
  }

  if (data.cancelTriage) {
    try {
      await publishTriageCancellation(deps, prSurface, {
        ...data,
        cancelTriage: data.cancelTriage,
      });
    } catch (error) {
      logWarn("ack_cancel_triage_failed", {
        workItemId: data.cancelTriage.workItemId,
        resourceKey,
        message: errorMessage(error),
      });
    }
  }

  if (data.progress) {
    const progressData = { ...data, progress: data.progress };
    if (
      data.workItemId != null &&
      !canAckPublishProgress(db, {
        workItemId: data.workItemId,
        resourceKey,
        reviewLens: progressData.progress.lens,
      })
    ) {
      logWarn("ack_progress_skipped_stale_owner", {
        workItemId: data.workItemId,
        resourceKey,
        reviewLens: progressData.progress.lens,
      });
    } else {
      await publishAckProgress(deps, progressData, prSurface, resourceKey);
    }
  }

  const reply = data.reply;
  if (reply && canWrite(prSurface, "commentsWrite")) {
    await deps.publication.once({
      decodeResult: () => undefined,
      allowsUndefinedResult: true,
      resourceTarget: "ack_reply",
      operationKey: "ack:reply",
      mutationKind: "github.ack_reply",
      mutate: async () => {
        await prSurface.replyAt(reply.target, reply.body);
      },
    });
  }

  if (data.reply && data.workItemId == null) {
    await publishReactions({
      publication: deps.publication,
      prSurface,
      targets: data.targets,
      content: GITHUB_REACTION_PLUS_ONE,
      logEvent: "ack_reaction_failed",
    });
  }
}
