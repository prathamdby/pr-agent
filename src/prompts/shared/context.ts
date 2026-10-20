import { BOT_SECRET_PATTERNS, MAX_ASK_THREAD_TRANSCRIPT_CHARS } from "../../settings/index.ts";
import type {
  DiscussionTrigger,
  PullRequestDiscussion,
} from "../../agent/discussion/pullRequestDiscussion.ts";
import type { ReviewThreadSnapshot } from "../../github/reviewThreadResolution.ts";
import { wrapUntrustedBlock } from "./safety.ts";

function escapeUntrustedReplyText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatReplyBlock(label: string, reply: string, index: number): string[] {
  return [
    `  ${label} ${index + 1}:`,
    wrapUntrustedBlock("maintainer_reply", escapeUntrustedReplyText(reply))
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  ];
}

export function formatHumanReplies(thread: {
  readonly humanReplies: readonly string[];
  readonly authorizedReplies?: readonly string[];
  readonly untrustedReplies?: readonly string[];
}): string[] {
  if (thread.authorizedReplies == null && thread.untrustedReplies == null) {
    return thread.humanReplies.flatMap((reply, index) =>
      formatReplyBlock("Maintainer reply", reply, index),
    );
  }

  return [
    ...(thread.authorizedReplies ?? []).flatMap((reply, index) =>
      formatReplyBlock("Authorized maintainer decision evidence", reply, index),
    ),
    ...(thread.untrustedReplies ?? []).flatMap((reply, index) =>
      formatReplyBlock("Untrusted commenter evidence", reply, index),
    ),
  ];
}

export function formatFindingThreadInventoryLines(
  thread: {
    readonly rootCommentId: number;
    readonly lens: string;
    readonly severity: string | null;
    readonly path: string;
    readonly line: number;
    readonly titleSnippet: string;
    readonly threadUrl: string;
    readonly humanReplies: readonly string[];
    readonly authorizedReplies?: readonly string[];
    readonly untrustedReplies?: readonly string[];
  },
  index: number,
): string[] {
  return [
    "",
    `${index + 1}. threadRootCommentId=${thread.rootCommentId}`,
    `  Lens: ${thread.lens}`,
    `  Severity: ${thread.severity ?? "unknown"}`,
    `  Location: ${thread.path}:L${thread.line}`,
    `  Finding: ${thread.titleSnippet}`,
    `  Thread: ${thread.threadUrl}`,
    ...formatHumanReplies(thread),
  ];
}

export const DISCUSSION_INCOMPLETE_NOTICE = "Discussion list is incomplete.";

export const DISCUSSION_CONVERSATION_NOT_LOADED = "Conversation was not loaded.";

export const DISCUSSION_OMISSION_MARKER = "…(earlier thread omitted)…";

const INLINE_HEADER = "Inline review threads:";
const CONVERSATION_HEADER = "Conversation:";

function redactDiscussionText(text: string): string {
  let out = text;
  for (const pattern of BOT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

function oneLineTitle(body: string): string {
  const line = redactDiscussionText(body).split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > 0 ? line : "(empty)";
}

function authorLogin(login: string | null | undefined): string {
  const trimmed = login?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "unknown";
}

type DiscussionBodyLine = {
  readonly author: string;
  readonly body: string;
};

type DiscussionItem = {
  readonly kind: "inline" | "conversation";
  readonly identity: string;
  readonly lines: readonly DiscussionBodyLine[];
};

function discussionBodyLines(
  comments: readonly { readonly author: string | null; readonly body: string }[],
): DiscussionBodyLine[] {
  return comments.map((comment) => ({
    author: authorLogin(comment.author),
    body: redactDiscussionText(comment.body.trim()) || "(empty)",
  }));
}

function formatDiscussionBody(lines: readonly DiscussionBodyLine[], share: number): string {
  if (share <= 0 || lines.length === 0) return "";
  const rendered = lines.map((line) => `${line.author}:\n${line.body}`);
  const full = rendered.join("\n\n");
  if (full.length <= share) return full;
  const root = rendered[0] ?? "";
  const sep = "\n\n";
  const budget = share - root.length - 2 * sep.length - DISCUSSION_OMISSION_MARKER.length;
  let tail = "";
  if (budget > 0) {
    for (let index = rendered.length - 1; index >= 1; index--) {
      const piece = rendered[index] ?? "";
      const next = tail.length === 0 ? piece : `${piece}${sep}${tail}`;
      if (next.length > budget) break;
      tail = next;
    }
  }
  const text =
    tail.length > 0
      ? `${root}${sep}${DISCUSSION_OMISSION_MARKER}${sep}${tail}`
      : root.slice(0, share);
  return text.length <= share ? text : text.slice(0, share);
}

function inlineIdentity(thread: ReviewThreadSnapshot, trigger?: DiscussionTrigger): string {
  const root = thread.comments[0];
  const marked =
    trigger?.kind === "inline" &&
    (thread.rootCommentId === trigger.commentId ||
      thread.comments.some((comment) => comment.databaseId === trigger.commentId));
  const url = root?.url.trim() ?? "";
  const parts = [
    `root=${thread.rootCommentId}`,
    `path=${thread.path ?? ""}`,
    `line=${thread.line ?? ""}`,
    `state=${thread.isResolved ? "resolved" : "open"}`,
    `outdated=${thread.isOutdated ? "yes" : "no"}`,
    `author=${authorLogin(root?.authorLogin)}`,
    `title=${oneLineTitle(root?.body ?? "")}`,
  ];
  if (url.length > 0) parts.push(`url=${url}`);
  if (marked) parts.push("trigger");
  if (!thread.commentsComplete) parts.push("comments incomplete");
  return parts.join(" ");
}

function conversationIdentity(
  group: readonly { readonly id: number; readonly authorLogin: string; readonly body: string }[],
  trigger?: DiscussionTrigger,
): string {
  const root = group[0];
  const marked =
    trigger?.kind === "conversation" && group.some((comment) => comment.id === trigger.commentId);
  return [
    `root=${root?.id ?? ""}`,
    "path=",
    "line=",
    "state=",
    "outdated=",
    `author=${authorLogin(root?.authorLogin)}`,
    `title=${oneLineTitle(root?.body ?? "")}`,
    ...(marked ? ["trigger"] : []),
  ].join(" ");
}

function discussionItems(
  discussion: PullRequestDiscussion,
  trigger?: DiscussionTrigger,
): DiscussionItem[] {
  const inline = discussion.reviewThreads.threads.map((thread) => ({
    kind: "inline" as const,
    identity: inlineIdentity(thread, trigger),
    lines: discussionBodyLines(
      thread.comments.map((comment) => ({ author: comment.authorLogin, body: comment.body })),
    ),
  }));
  if (!discussion.conversation.loaded) return inline;
  const conversation = discussion.conversation.groups.map((group) => ({
    kind: "conversation" as const,
    identity: conversationIdentity(group, trigger),
    lines: discussionBodyLines(
      group.map((comment) => ({ author: comment.authorLogin, body: comment.body })),
    ),
  }));
  return [...inline, ...conversation];
}

export function formatPullRequestDiscussion(
  discussion: PullRequestDiscussion,
  trigger?: DiscussionTrigger,
  maxChars: number = MAX_ASK_THREAD_TRANSCRIPT_CHARS,
): string {
  if (maxChars <= 0) return "";
  const review = discussion.reviewThreads;
  const conversation = discussion.conversation;
  const knownIncomplete =
    review.truncated === true ||
    review.status === "partial" ||
    (conversation.loaded && conversation.truncated);
  const prefix: string[] = [];
  if (review.status !== "ok" && review.warning != null && review.warning.length > 0) {
    prefix.push(review.warning);
  }
  if (!conversation.loaded) prefix.push(DISCUSSION_CONVERSATION_NOT_LOADED);

  const items = discussionItems(discussion, trigger);
  const chrome = (showNotice: boolean): string[] => {
    const lines = [...prefix];
    if (showNotice) lines.push(DISCUSSION_INCOMPLETE_NOTICE);
    lines.push(INLINE_HEADER);
    if (review.threads.length === 0) lines.push("none");
    lines.push(CONVERSATION_HEADER);
    if (conversation.loaded && conversation.groups.length === 0) lines.push("none");
    return lines;
  };

  const takeNamed = (showNotice: boolean): { named: DiscussionItem[]; stopped: boolean } => {
    const room = Math.max(0, maxChars - chrome(showNotice).join("\n").length);
    const named: DiscussionItem[] = [];
    let used = 0;
    for (const item of items) {
      const cost = item.identity.length + 1;
      if (used + cost > room) return { named, stopped: true };
      named.push(item);
      used += cost;
    }
    return { named, stopped: false };
  };

  let showNotice = knownIncomplete;
  let fitted = takeNamed(showNotice);
  if (fitted.stopped && !showNotice) {
    showNotice = true;
    fitted = takeNamed(true);
  }

  const namedInline = fitted.named.filter((item) => item.kind === "inline");
  const namedConversation = fitted.named.filter((item) => item.kind === "conversation");
  const skeleton = chrome(showNotice);
  if (review.threads.length > 0) {
    const headerAt = skeleton.indexOf(INLINE_HEADER);
    skeleton.splice(headerAt + 1, 0, ...namedInline.map((item) => item.identity));
  }
  if (!(conversation.loaded && conversation.groups.length === 0)) {
    skeleton.push(...namedConversation.map((item) => item.identity));
  }
  const skeletonText = skeleton.join("\n");
  const named = [...namedInline, ...namedConversation];
  const leftover = maxChars - skeletonText.length;
  const share = named.length === 0 ? 0 : Math.floor(Math.max(0, leftover) / named.length) - 1;
  const bodyByItem = new Map(
    named.map((item) => [item, formatDiscussionBody(item.lines, Math.max(0, share))] as const),
  );

  const lines = [...prefix];
  if (showNotice) lines.push(DISCUSSION_INCOMPLETE_NOTICE);
  lines.push(INLINE_HEADER);
  if (review.threads.length === 0) lines.push("none");
  else {
    for (const item of namedInline) {
      lines.push(item.identity);
      const body = bodyByItem.get(item) ?? "";
      if (body.length > 0) lines.push(body);
    }
  }
  lines.push(CONVERSATION_HEADER);
  if (conversation.loaded && conversation.groups.length === 0) lines.push("none");
  else {
    for (const item of namedConversation) {
      lines.push(item.identity);
      const body = bodyByItem.get(item) ?? "";
      if (body.length > 0) lines.push(body);
    }
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
