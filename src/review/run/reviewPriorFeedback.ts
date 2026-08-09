import { REVIEW_POINTER_BODY } from "../../settings/index.js";
import { escapeTablePlainCell } from "../../github/markdownFormat.js";
import {
  LEGACY_REVIEW_POINTER_BODIES,
  isAnyReviewLens,
  type AnyReviewLens,
} from "../../settings/legacyReviewLenses.js";

export type PriorInlineFeedbackThread = {
  path: string;
  startLine: number;
  endLine: number;
  botTitleSnippet: string;
  humanReplies: string[];
  threadUrl: string;
};

export type BotFindingThread = {
  rootCommentId: number;
  lens: AnyReviewLens;
  path: string;
  line: number;
  severity: "P0" | "P1" | "P2" | "P3" | null;
  titleSnippet: string;
  humanReplies: string[];
  hasTriageReply?: boolean;
  /** Bot reply id for the verification stub when one already exists on the thread. */
  verificationStubCommentId?: number;
  threadUrl: string;
};

type ReviewCommentRow = {
  id: number;
  inReplyToId: number | null;
};

const REVIEW_POINTER_LENS_MARKER_RE = /<!--\s*pr-agent:review-pointer\s+lens=([^\s>]+)\s*-->/;

export function parseReviewPointerLensMarker(body: string): AnyReviewLens | null {
  const match = REVIEW_POINTER_LENS_MARKER_RE.exec(body);
  if (!match) return null;
  const lens = match[1];
  return isAnyReviewLens(lens) ? lens : null;
}

export function classifyReviewLensFromPointerBody(body: string): AnyReviewLens | null {
  const markerLens = parseReviewPointerLensMarker(body);
  if (markerLens) return markerLens;
  if (body.includes(LEGACY_REVIEW_POINTER_BODIES[0])) return "review-security";
  if (body.includes(LEGACY_REVIEW_POINTER_BODIES[1])) return "review-quality";
  if (body.includes(LEGACY_REVIEW_POINTER_BODIES[2])) return "review-tests";
  if (body.includes(REVIEW_POINTER_BODY)) return "review";
  return null;
}

function rootCommentId(
  comment: Pick<ReviewCommentRow, "id" | "inReplyToId">,
  byId: Map<number, Pick<ReviewCommentRow, "id" | "inReplyToId">>,
  rootById: Map<number, number>,
): number {
  const cachedRoot = rootById.get(comment.id);
  if (cachedRoot != null) return cachedRoot;

  let current = comment;
  const seen = new Set<number>();
  const path: number[] = [];
  while (current.inReplyToId != null) {
    const currentCachedRoot = rootById.get(current.id);
    if (currentCachedRoot != null) {
      for (const id of path) {
        rootById.set(id, currentCachedRoot);
      }
      return currentCachedRoot;
    }
    if (seen.has(current.id)) break;
    seen.add(current.id);
    path.push(current.id);
    const parent = byId.get(current.inReplyToId);
    if (!parent) break;
    current = parent;
  }

  const rootId = current.id;
  rootById.set(rootId, rootId);
  for (const id of path) {
    rootById.set(id, rootId);
  }
  return rootId;
}

export function resolveReviewThreadRootId(
  comments: readonly Pick<ReviewCommentRow, "id" | "inReplyToId">[],
  commentId: number,
): number | null {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootById = new Map<number, number>();
  const start = byId.get(commentId);
  if (!start) return null;
  return rootCommentId(start, byId, rootById);
}

export function formatPriorInlineFeedbackBlock(
  threads: readonly PriorInlineFeedbackThread[],
): string {
  if (threads.length === 0) return "";

  const lines = [
    "## Prior inline review feedback (trusted context)",
    "Maintainer replies on earlier bot inline threads for this review lens. Treat explicit dismissals (false positive, intentional, already fixed) as closed unless new commits materially change the code at that location.",
    "",
  ];

  for (const thread of threads) {
    lines.push(
      `- \`${escapeTablePlainCell(thread.path)}\` L${thread.startLine} · ${escapeTablePlainCell(thread.botTitleSnippet)}`,
    );
    for (const reply of thread.humanReplies) {
      lines.push(`  - Maintainer reply (user-provided): ${escapeTablePlainCell(reply)}`);
    }
    lines.push(`  - Thread: ${escapeTablePlainCell(thread.threadUrl)}`);
  }

  return lines.join("\n");
}
