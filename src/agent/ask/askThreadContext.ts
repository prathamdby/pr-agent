import { logWarn } from "../../evlog.js";
import { MAX_ASK_THREAD_TRANSCRIPT_CHARS } from "../../settings/index.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import type { PrSurface } from "../../github/prSurface.js";
import { redactOutboundSecrets } from "./askSafety.js";

export type ThreadComment = {
  readonly id: number;
  readonly inReplyToId: number | null;
  readonly authorLogin: string;
  readonly body: string;
};

export type AskThreadTranscript = {
  readonly text: string;
  readonly truncated: boolean;
};

const TRANSCRIPT_OMISSION_MARKER = "…(earlier thread omitted)…";

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
  const byId = new Map(all.map((c) => [c.id, c]));
  const anchor = byId.get(anchorCommentId);
  if (!anchor) return [];
  const memo = new Map<number, number>();
  const rootId = rootCommentId(anchor, byId, memo);
  return all.filter((c) => rootCommentId(c, byId, memo) === rootId).toSorted((a, b) => a.id - b.id);
}

export type ThreadTranscriptFormat = {
  readonly text: string;
  readonly truncated: boolean;
};

export function formatThreadTranscript(
  comments: readonly ThreadComment[],
  maxChars: number = MAX_ASK_THREAD_TRANSCRIPT_CHARS,
): ThreadTranscriptFormat {
  if (comments.length === 0) return { text: "", truncated: false };
  const lines = comments.map((c) => {
    const login = c.authorLogin.trim() || "unknown";
    const body = redactOutboundSecrets(c.body.trim()) || "(empty)";
    return `${login}:\n${body}`;
  });
  const full = lines.join("\n\n");
  if (full.length <= maxChars) return { text: full, truncated: false };

  // Keep root (first) + newest tail that fits.
  const root = lines[0] ?? "";
  const sep = "\n\n";
  const budget = maxChars - root.length - 2 * sep.length - TRANSCRIPT_OMISSION_MARKER.length;
  let tail = "";
  if (budget > 0) {
    for (let i = lines.length - 1; i >= 1; i--) {
      const piece = lines[i] ?? "";
      const next = tail.length === 0 ? piece : `${piece}${sep}${tail}`;
      if (next.length > budget) break;
      tail = next;
    }
  }
  const text =
    tail.length > 0
      ? `${root}${sep}${TRANSCRIPT_OMISSION_MARKER}${sep}${tail}`
      : root.slice(0, maxChars);
  return { text, truncated: true };
}

/**
 * Load the containing comment thread for an ask. Soft-degrades to empty on failure.
 */
export async function loadAskThreadTranscript(params: {
  readonly prSurface: PrSurface;
  readonly replyTarget: ReplyTarget;
  readonly commentId: number;
}): Promise<AskThreadTranscript> {
  const { prSurface, replyTarget, commentId } = params;
  try {
    if (replyTarget.kind === "inlineReviewThread") {
      const all = await prSurface.listInlineReviewComments();
      const thread = commentsInThread(all, replyTarget.inReplyToCommentId);
      return formatThreadTranscript(thread);
    }

    const all = await prSurface.listConversationComments();
    const byId = new Map(all.map((c) => [c.id, c]));
    const anchor = byId.get(commentId);
    if (!anchor) {
      return { text: "", truncated: false };
    }
    if (anchor.inReplyToId == null && !all.some((c) => c.inReplyToId === anchor.id)) {
      // No reply threading available — single comment context.
      return formatThreadTranscript([anchor]);
    }
    const thread = commentsInThread(all, commentId);
    return formatThreadTranscript(thread.length > 0 ? thread : [anchor]);
  } catch (error) {
    logWarn("ask_thread_transcript_load_failed", {
      owner: prSurface.owner,
      repo: prSurface.repo,
      pr: replyTarget.prNumber,
      commentId,
      replyTargetKind: replyTarget.kind,
      message: error instanceof Error ? error.message : String(error),
    });
    return { text: "", truncated: false };
  }
}
