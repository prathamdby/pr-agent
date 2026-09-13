import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { PrSurface } from "../../github/prSurface.js";
import type { PrConversationComment } from "../../github/prSurfaceTypes.js";
import { parseReviewMetaFromCommentBody } from "../../review/ci/reviewMetaParse.js";
import { LEGACY_REVIEW_SUMMARY_SENTINELS } from "../../settings/legacyReviewLenses.js";
import { REVIEW_SUMMARY_SENTINEL, VERIFICATION_PUBLISH_LENS } from "../../settings/index.js";
import { enqueueCiProjectionDebouncedStandalone } from "../../agentWork/intake/queueing.js";
import { recordPublishStep } from "../../agentWork/repository.js";
import {
  clearVerificationFailureSignalFromLedger,
  loadVerificationThreadLedger,
  saveVerificationThreadLedger,
  upsertVerificationFailureSignal,
  type VerificationFailureSignal,
  type VerificationThreadLedger,
} from "../../agentWork/verificationThreadLedger.js";
import type { CiProjectionJobData } from "../../agentWork/types.js";

const REVIEW_SUMMARY_SENTINELS = [
  REVIEW_SUMMARY_SENTINEL,
  ...LEGACY_REVIEW_SUMMARY_SENTINELS,
] as const;

type PublishVerificationFailureParams = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly leaseEpoch: number | null;
  readonly boss?: PgBoss;
  readonly installationId?: number;
};

function isReviewSummaryBody(body: string): boolean {
  return REVIEW_SUMMARY_SENTINELS.some((sentinel) => body.startsWith(sentinel));
}

function findHeadReviewComment(
  comments: readonly PrConversationComment[],
  headSha: string,
): PrConversationComment | undefined {
  return comments.findLast(
    (comment) =>
      isReviewSummaryBody(comment.body) &&
      parseReviewMetaFromCommentBody(comment.body)?.headSha === headSha,
  );
}

async function botOwnedComments(prSurface: PrSurface): Promise<readonly PrConversationComment[]> {
  const botLogin = await prSurface.getBotLogin?.();
  if (botLogin == null) return [];
  const comments = await prSurface.listConversationComments();
  return comments.filter((comment) => comment.authorLogin === botLogin);
}

async function persistLedger(
  params: PublishVerificationFailureParams,
  ledger: VerificationThreadLedger,
): Promise<void> {
  await saveVerificationThreadLedger(params.pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    ledger,
    leaseEpoch: params.leaseEpoch,
  });
}

async function enqueueProjection(params: PublishVerificationFailureParams): Promise<void> {
  if (params.boss == null || params.installationId == null || params.installationId <= 0) return;
  const job: CiProjectionJobData = {
    kind: "ci_projection",
    installationId: params.installationId,
    owner: params.prSurface.owner,
    repo: params.prSurface.repo,
    headSha: params.headSha,
  };
  await enqueueCiProjectionDebouncedStandalone(params.boss, job);
}

export async function publishVerificationFailure(
  params: PublishVerificationFailureParams,
): Promise<VerificationFailureSignal> {
  await recordPublishStep(params.pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: VERIFICATION_PUBLISH_LENS,
    step: "verification_failure",
    leaseEpoch: params.leaseEpoch,
    detail: { headSha: params.headSha, active: true },
  });
  await enqueueProjection(params);

  const comments = await botOwnedComments(params.prSurface);
  const headReview = findHeadReviewComment(comments, params.headSha);
  const signal: VerificationFailureSignal = {
    headSha: params.headSha,
    commentId: headReview?.id ?? 0,
    surface: "ci_cell",
  };
  const ledger = await loadVerificationThreadLedger(params.pool, {
    resourceKey: params.resourceKey,
  });
  await persistLedger(params, upsertVerificationFailureSignal(ledger, signal));
  return signal;
}

export async function clearVerificationFailureSignal(
  params: PublishVerificationFailureParams,
): Promise<void> {
  await recordPublishStep(params.pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: VERIFICATION_PUBLISH_LENS,
    step: "verification_failure",
    leaseEpoch: params.leaseEpoch,
    detail: { headSha: params.headSha, active: false },
  });
  await enqueueProjection(params);
  const ledger = await loadVerificationThreadLedger(params.pool, {
    resourceKey: params.resourceKey,
  });
  if (ledger.failureSignal == null) return;
  await persistLedger(params, clearVerificationFailureSignalFromLedger(ledger));
}
