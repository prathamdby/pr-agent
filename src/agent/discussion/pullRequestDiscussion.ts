import { logWarn } from "../../evlog.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { PrConversationComment } from "../../github/prSurfaceTypes.ts";
import type { ListReviewThreadResolutionResult } from "../../github/reviewThreadResolution.ts";

export type ThreadComment = PrConversationComment;

export type DiscussionTrigger =
  | { readonly kind: "inline"; readonly commentId: number }
  | { readonly kind: "conversation"; readonly commentId: number };

export type ConversationLoad =
  | {
      readonly loaded: true;
      readonly comments: readonly PrConversationComment[];
      readonly groups: readonly (readonly ThreadComment[])[];
      readonly truncated: boolean;
    }
  | { readonly loaded: false };

export type PullRequestDiscussion = {
  readonly reviewThreads: ListReviewThreadResolutionResult;
  readonly conversation: ConversationLoad;
};

export function emptyPullRequestDiscussion(): PullRequestDiscussion {
  return {
    reviewThreads: {
      byRootCommentId: new Map(),
      threads: [],
      status: "ok",
    },
    conversation: { loaded: true, comments: [], groups: [], truncated: false },
  };
}

function rootCommentId(
  start: ThreadComment,
  byId: Map<number, ThreadComment>,
  memo: Map<number, number>,
): number {
  const cached = memo.get(start.id);
  if (cached != null) return cached;
  let current: ThreadComment = start;
  const chain: number[] = [];
  while (current.inReplyToId != null) {
    if (chain.includes(current.id) || current.inReplyToId === current.id) break;
    chain.push(current.id);
    const parent = byId.get(current.inReplyToId);
    if (!parent) break;
    current = parent;
  }
  const rootId = current.id;
  memo.set(start.id, rootId);
  memo.set(rootId, rootId);
  for (const id of chain) memo.set(id, rootId);
  return rootId;
}

export function commentsInThread(
  all: readonly ThreadComment[],
  anchorCommentId: number,
): ThreadComment[] {
  const byId = new Map(all.map((comment) => [comment.id, comment]));
  const anchor = byId.get(anchorCommentId);
  if (!anchor) return [];
  const memo = new Map<number, number>();
  const rootId = rootCommentId(anchor, byId, memo);
  return all
    .filter((comment) => rootCommentId(comment, byId, memo) === rootId)
    .toSorted((a, b) => a.id - b.id);
}

export function commentThreadGroups(all: readonly ThreadComment[]): ThreadComment[][] {
  const byId = new Map(all.map((comment) => [comment.id, comment]));
  const memo = new Map<number, number>();
  const groups = new Map<number, ThreadComment[]>();
  const order: number[] = [];
  for (const comment of all) {
    const rootId = rootCommentId(comment, byId, memo);
    const existing = groups.get(rootId);
    if (existing == null) {
      groups.set(rootId, [comment]);
      order.push(rootId);
    } else {
      existing.push(comment);
    }
  }
  return order.map((rootId) => (groups.get(rootId) ?? []).toSorted((a, b) => a.id - b.id));
}

export async function loadPullRequestDiscussion(
  prSurface: PrSurface,
): Promise<PullRequestDiscussion> {
  const reviewThreads = await prSurface.listInlineReviewThreads();
  try {
    const conversation = await prSurface.listConversationComments();
    return {
      reviewThreads,
      conversation: {
        loaded: true,
        comments: conversation.comments,
        groups: commentThreadGroups(conversation.comments),
        truncated: conversation.truncated,
      },
    };
  } catch (error) {
    logWarn("pull_request_discussion_conversation_failed", {
      owner: prSurface.owner,
      repo: prSurface.repo,
      pr: prSurface.prNumber,
      message: errorMessage(error),
    });
    return { reviewThreads, conversation: { loaded: false } };
  }
}
