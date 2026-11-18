import type { PrSurface } from "../../github/prSurfaceTypes.ts";
import type { ReviewThreadSnapshotComment } from "../../github/reviewThreadResolution.ts";
import { isBotAuthor, parseOwnedReceipts, renderReceipt, type FindingId } from "./findingMarker.ts";

export type ResolutionReceiptKind = "fixed" | "dismissed";

type ReceiptTarget = {
  readonly threadNodeId: string;
  readonly findingId: FindingId;
  readonly kind: ResolutionReceiptKind;
};

function hasPostedReceipt(
  comments: readonly ReviewThreadSnapshotComment[],
  botLogin: string,
  target: ReceiptTarget,
) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    parseOwnedReceipts(comments, botLogin).some(
      (receipt) => receipt.kind === target.kind && receipt.id === target.findingId,
    ),
  );
}

export async function unpostedResolutionReceipt(
  surface: Pick<PrSurface, "getBotLogin" | "getReviewThread">,
  params: ReceiptTarget & { readonly ownCommentId?: number },
) {
  const [botLogin, thread] = await Promise.all([
    surface.getBotLogin(),
    surface.getReviewThread(params.threadNodeId),
  ]);
  const others = (thread?.comments ?? []).filter(
    (comment) => comment.databaseId !== params.ownCommentId,
  );
  return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(
    hasPostedReceipt(others, botLogin, params)
      ? null
      : `\n\n${renderReceipt({ kind: params.kind, id: params.findingId })}`,
  );
}

export async function appendRootResolutionReceipt(
  surface: Pick<PrSurface, "getBotLogin" | "getReviewThread" | "editReviewComment">,
  target: ReceiptTarget,
) {
  const [botLogin, thread] = await Promise.all([
    surface.getBotLogin(),
    surface.getReviewThread(target.threadNodeId),
  ]);
  const root = thread?.comments[0];
  if (thread == null || root == null || !isBotAuthor(root.authorLogin, botLogin))
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  if (hasPostedReceipt(thread.comments, botLogin, target))
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(
    surface.editReviewComment(
      root.databaseId,
      `${root.body}\n${renderReceipt({ kind: target.kind, id: target.findingId })}`,
    ),
  );
}
