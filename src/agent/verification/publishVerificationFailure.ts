import { logWarn } from "../../evlog.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import { immediate } from "../../state/db.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { PrConversationComment } from "../../github/prSurfaceTypes.ts";
import { parseReviewMetaFromCommentBody } from "../../review/run/commentMarkers.ts";
import {
  LEGACY_REVIEW_SUMMARY_SENTINELS,
  REVIEW_SUMMARY_SENTINEL,
  VERIFICATION_FAILURE_END,
  VERIFICATION_FAILURE_START,
  VERIFICATION_PUBLISH_LENS,
} from "../../settings/index.ts";
import {
  advanceHeadCiVersionForVerificationSignal,
  isEffectiveVerificationSignalTransition,
  requestHeadCiProjectionTx,
  type VerificationSignalPrior,
} from "../../state/prHeadCiState.ts";
import { latestPublishStep, type FeaturePublication } from "../../state/featurePublication.ts";
import {
  clearVerificationFailureSignalFromLedger,
  loadVerificationThreadLedger,
  upsertVerificationFailureSignal,
  type VerificationFailureSignal,
  type VerificationThreadLedger,
} from "../../state/verificationThreadLedger.ts";

const REVIEW_SUMMARY_SENTINELS = [
  REVIEW_SUMMARY_SENTINEL,
  ...LEGACY_REVIEW_SUMMARY_SENTINELS,
] as const;

type PublishVerificationFailureParams = {
  readonly publication: FeaturePublication;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly installationId: number;
};

function isReviewSummaryBody(body: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    REVIEW_SUMMARY_SENTINELS.some((sentinel) => body.startsWith(sentinel)),
  );
}

function findHeadReviewComment(comments: readonly PrConversationComment[], headSha: string) {
  return ((pinnedReturn: PrConversationComment | undefined) => pinnedReturn)(
    comments.findLast(
      (comment) =>
        isReviewSummaryBody(comment.body) &&
        parseReviewMetaFromCommentBody(comment.body)?.headSha === headSha,
    ),
  );
}

async function botOwnedComments(prSurface: PrSurface) {
  const botLogin = await prSurface.getBotLogin();
  const comments = (await prSurface.listConversationComments()).comments;
  return ((
    pinnedReturn: readonly PrConversationComment[] | Promise<readonly PrConversationComment[]>,
  ) => pinnedReturn)(comments.filter((comment) => comment.authorLogin === botLogin));
}

function persistLedger(params: PublishVerificationFailureParams, ledger: VerificationThreadLedger) {
  params.publication.record({
    lens: VERIFICATION_PUBLISH_LENS,
    step: "verification_thread_actions",
    detail: {
      threads: ledger.threads,
      ...(ledger.failureSignal != null ? { failureSignal: ledger.failureSignal } : {}),
    },
  });
}

function priorFromDetail(detail: Record<string, unknown> | undefined) {
  if (detail == null) return ((pinnedReturn: VerificationSignalPrior | null) => pinnedReturn)(null);
  const headSha = typeof detail.headSha === "string" ? detail.headSha : null;
  return ((pinnedReturn: VerificationSignalPrior | null) => pinnedReturn)({
    active: detail.active !== false && headSha != null,
    headSha,
  });
}

function writeVerificationSignal(params: PublishVerificationFailureParams, active: boolean) {
  if (params.installationId <= 0) {
    throw new Error("verification failure projection requires a positive installationId");
  }
  const db = params.publication.db;
  const now = Date.now();
  const head = {
    installationId: params.installationId,
    owner: params.prSurface.owner,
    repo: params.prSurface.repo,
    headSha: params.headSha,
  };
  immediate(db, () => {
    const priorDetail = latestPublishStep(
      db,
      params.resourceKey,
      VERIFICATION_PUBLISH_LENS,
      "verification_failure",
    );
    const effective = isEffectiveVerificationSignalTransition(priorFromDetail(priorDetail), {
      active,
      headSha: params.headSha,
    });
    advanceHeadCiVersionForVerificationSignal(db, { ...head, effective }, now);
    params.publication.record({
      lens: VERIFICATION_PUBLISH_LENS,
      step: "verification_failure",
      detail: { headSha: params.headSha, active },
    });
    requestHeadCiProjectionTx(db, head, { kind: "debounced" }, now);
  });
}

export async function publishVerificationFailure(params: PublishVerificationFailureParams) {
  writeVerificationSignal(params, true);

  const comments = await botOwnedComments(params.prSurface);
  const headReview = findHeadReviewComment(comments, params.headSha);
  const signal: VerificationFailureSignal = {
    headSha: params.headSha,
    commentId: headReview?.id ?? 0,
    surface: "ci_cell",
  };
  const ledger = loadVerificationThreadLedger(params.publication.db, {
    resourceKey: params.resourceKey,
  });
  persistLedger(params, upsertVerificationFailureSignal(ledger, signal));
  return ((pinnedReturn: VerificationFailureSignal | Promise<VerificationFailureSignal>) =>
    pinnedReturn)(signal);
}

function withoutVerificationFailureBlock(body: string) {
  const start = body.indexOf(VERIFICATION_FAILURE_START);
  if (start < 0) return ((pinnedReturn: string | null) => pinnedReturn)(null);
  const end = body.indexOf(VERIFICATION_FAILURE_END, start + VERIFICATION_FAILURE_START.length);
  if (end < 0) return ((pinnedReturn: string | null) => pinnedReturn)(null);
  return ((pinnedReturn: string | null) => pinnedReturn)(
    body.slice(0, start) + body.slice(end + VERIFICATION_FAILURE_END.length),
  );
}

async function stripStoredVerificationFailure(
  params: PublishVerificationFailureParams,
  commentId: number,
) {
  if (commentId <= 0) return;
  try {
    const comments = await botOwnedComments(params.prSurface);
    const comment = comments.find((item) => item.id === commentId);
    if (comment == null || !isReviewSummaryBody(comment.body)) return;
    const next = withoutVerificationFailureBlock(comment.body);
    if (next == null) return;
    await params.publication.once({
      decodeResult: () => undefined,
      allowsUndefinedResult: true,
      resourceTarget: `comment:${commentId}`,
      blocksOverwrite: true,
      operationKey: `verification:failure_strip:${commentId}:${params.headSha}`,
      mutationKind: "github.verification_failure_strip",
      mutate: () => params.prSurface.editComment(commentId, next),
    });
  } catch (error) {
    logWarn("verification_failure_strip_failed", {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      commentId,
      message: errorMessage(error),
    });
  }
}

export async function clearVerificationFailureSignal(params: PublishVerificationFailureParams) {
  writeVerificationSignal(params, false);
  const ledger = loadVerificationThreadLedger(params.publication.db, {
    resourceKey: params.resourceKey,
  });
  if (ledger.failureSignal == null) return;
  await stripStoredVerificationFailure(params, ledger.failureSignal.commentId);
  persistLedger(params, clearVerificationFailureSignalFromLedger(ledger));
}
