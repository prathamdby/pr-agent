import { installationOctokit } from "../../github/appAuth.js";
import { paginateOctokitPages } from "../../github/paginateOctokit.js";
import { logWarn } from "../../evlog.js";
import {
  COMMENT_PAGINATION_MAX_PAGES,
  COMMENTS_PAGE_SIZE,
  MAX_ASK_THREAD_TRANSCRIPT_CHARS,
} from "../../settings/index.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";

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

function rootCommentId(
  start: ThreadComment,
  byId: Map<number, ThreadComment>,
  memo: Map<number, number>,
): number {
  const cached = memo.get(start.id);
  if (cached != null) return cached;
  let current: ThreadComment = start;
  const seen = new Set<number>();
  while (current.inReplyToId != null) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    const parent = byId.get(current.inReplyToId);
    if (!parent) break;
    current = parent;
  }
  memo.set(start.id, current.id);
  return current.id;
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

export function formatThreadTranscript(
  comments: readonly ThreadComment[],
  maxChars: number = MAX_ASK_THREAD_TRANSCRIPT_CHARS,
): { text: string; truncated: boolean } {
  if (comments.length === 0) return { text: "", truncated: false };
  const lines = comments.map((c) => {
    const login = c.authorLogin.trim() || "unknown";
    const body = c.body.trim() || "(empty)";
    return `${login}:\n${body}`;
  });
  const full = lines.join("\n\n");
  if (full.length <= maxChars) return { text: full, truncated: false };

  // Keep root (first) + newest tail that fits.
  const root = lines[0] ?? "";
  const sep = "\n\n";
  const budget = maxChars - root.length - sep.length - "…(earlier thread omitted)…".length;
  let tail = "";
  for (let i = lines.length - 1; i >= 1; i--) {
    const piece = lines[i] ?? "";
    const next = tail.length === 0 ? piece : `${piece}${sep}${tail}`;
    if (next.length > budget) break;
    tail = next;
  }
  const text =
    tail.length > 0
      ? `${root}${sep}…(earlier thread omitted)…${sep}${tail}`
      : root.slice(0, maxChars);
  return { text, truncated: true };
}

async function listInlineReviewComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
): Promise<ThreadComment[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const rows = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  return rows.map((c) => ({
    id: c.id,
    inReplyToId: c.in_reply_to_id ?? null,
    authorLogin: c.user?.login ?? "unknown",
    body: c.body ?? "",
  }));
}

async function listIssueComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
): Promise<ThreadComment[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const rows = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  return rows.map((c) => ({
    id: c.id,
    // Octokit typings may omit reply threading; read when present.
    inReplyToId:
      "in_reply_to_id" in c && typeof c.in_reply_to_id === "number" ? c.in_reply_to_id : null,
    authorLogin: c.user?.login ?? "unknown",
    body: c.body ?? "",
  }));
}

/**
 * Load the containing comment thread for an ask. Soft-degrades to empty on failure.
 */
export async function loadAskThreadTranscript(params: {
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly replyTarget: ReplyTarget;
  readonly commentId: number;
}): Promise<AskThreadTranscript> {
  const { token, tokenExpiresAtTs, owner, repo, replyTarget, commentId } = params;
  try {
    if (replyTarget.kind === "inlineReviewThread") {
      const all = await listInlineReviewComments(
        token,
        owner,
        repo,
        replyTarget.prNumber,
        tokenExpiresAtTs,
      );
      const thread = commentsInThread(all, replyTarget.inReplyToCommentId);
      return formatThreadTranscript(thread);
    }

    const all = await listIssueComments(token, owner, repo, replyTarget.prNumber, tokenExpiresAtTs);
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
      owner,
      repo,
      pr: replyTarget.prNumber,
      commentId,
      replyTargetKind: replyTarget.kind,
      message: error instanceof Error ? error.message : String(error),
    });
    return { text: "", truncated: false };
  }
}
