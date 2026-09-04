import type { Pool } from "pg";
import type { PrSurface } from "../../github/prSurface.js";
import type { PrConversationComment } from "../../github/prSurfaceTypes.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.js";
import { parseReviewMetaFromCommentBody } from "../../review/ci/reviewMetaParse.js";
import { LEGACY_REVIEW_SUMMARY_SENTINELS } from "../../settings/legacyReviewLenses.js";
import {
  REVIEW_SUMMARY_SENTINEL,
  VERIFICATION_FAILURE_START,
  VERIFICATION_PUBLISH_LENS,
} from "../../settings/index.js";
import {
  clearVerificationFailureSignalFromLedger,
  loadVerificationThreadLedger,
  saveVerificationThreadLedger,
  upsertVerificationFailureSignal,
  type VerificationFailureSignal,
  type VerificationThreadLedger,
} from "../../agentWork/verificationThreadLedger.js";
import {
  operationIntentMarker,
  verificationFailureOperationKey,
  withOperationIntent,
} from "../../agentWork/withOperationIntent.js";
import {
  applyVerificationFailureToComment,
  commentHasVisibleVerificationFailure,
  isClearedVerificationFailureStub,
  renderClearedVerificationFailureStub,
  renderVerificationFailureBlock,
  stripVerificationFailureFromComment,
} from "./verificationFailureSignal.js";

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

function findFailureStubComment(
  comments: readonly PrConversationComment[],
): PrConversationComment | undefined {
  return comments.findLast((comment) => comment.body.startsWith(VERIFICATION_FAILURE_START));
}

function findCommentWithFailure(
  comments: readonly PrConversationComment[],
): PrConversationComment | undefined {
  return comments.findLast((comment) => commentHasVisibleVerificationFailure(comment.body));
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

async function recoverFailureCommentId(prSurface: PrSurface): Promise<number | undefined | null> {
  const botLogin = await prSurface.getBotLogin?.();
  if (botLogin == null) return null;
  const comments = await prSurface.listConversationComments();
  return findCommentIdByMarker(
    comments,
    VERIFICATION_FAILURE_START,
    (comment) => comment.authorLogin === botLogin,
  );
}

export async function publishVerificationFailure(
  params: PublishVerificationFailureParams,
): Promise<VerificationFailureSignal> {
  const comments = await botOwnedComments(params.prSurface);
  const headReview = findHeadReviewComment(comments, params.headSha);
  const existingStub = findFailureStubComment(comments);
  const target = headReview ?? existingStub;
  const operationKey = verificationFailureOperationKey(params.headSha);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);

  const commentId = await withOperationIntent<number>({
    client: params.pool,
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    operationKey,
    mutationKind: "github.verification_thread",
    detail: {
      step: "verification_thread_actions",
      resourceKey: params.resourceKey,
      reviewLens: VERIFICATION_PUBLISH_LENS,
      headSha: params.headSha,
      operationMarker,
    },
    recover: async () => {
      const recovered = await recoverFailureCommentId(params.prSurface);
      return recovered == null
        ? { kind: "absent" as const }
        : { kind: "reconciled" as const, value: recovered };
    },
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    mutate: async () => {
      if (target != null) {
        const applied = applyVerificationFailureToComment(target.body);
        if (applied.changed) {
          await params.prSurface.editComment(target.id, applied.nextBody);
        }
        return target.id;
      }
      const created = await params.prSurface.upsertProgressComment(
        renderVerificationFailureBlock(),
        VERIFICATION_FAILURE_START,
      );
      return created.id;
    },
  });

  const appliedSurface =
    target != null ? applyVerificationFailureToComment(target.body).surface : "stub_line";
  const signal: VerificationFailureSignal = {
    headSha: params.headSha,
    commentId,
    surface: appliedSurface,
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
  const comments = await botOwnedComments(params.prSurface);
  const ledger = await loadVerificationThreadLedger(params.pool, {
    resourceKey: params.resourceKey,
  });
  const recorded = ledger.failureSignal;
  const ledgerTarget =
    recorded == null ? undefined : comments.find((comment) => comment.id === recorded.commentId);
  const target = ledgerTarget ?? findCommentWithFailure(comments);
  if (target != null) {
    const stripped = stripVerificationFailureFromComment(target.body);
    if (stripped.changed) {
      const nextBody = stripped.nextBody.trim();
      if (nextBody.length > 0) {
        await params.prSurface.editComment(target.id, stripped.nextBody);
      } else if (!isClearedVerificationFailureStub(target.body)) {
        await params.prSurface.editComment(target.id, renderClearedVerificationFailureStub());
      }
    }
  }
  if (ledger.failureSignal == null && target == null) return;
  await persistLedger(params, clearVerificationFailureSignalFromLedger(ledger));
}
