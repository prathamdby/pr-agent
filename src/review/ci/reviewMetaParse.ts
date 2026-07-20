const REVIEW_META_RE =
  /<!--\s*pr-agent:review-meta\s+headSha=([^\s]+)\s+lens=([^\s]+)\s+stale=(true|false)\s*-->/;

export type ParsedReviewMeta = {
  readonly headSha: string;
  readonly lens: string;
  readonly stale: boolean;
};

export function parseReviewMetaFromCommentBody(body: string): ParsedReviewMeta | null {
  const match = body.match(REVIEW_META_RE);
  if (match == null) return null;
  return {
    headSha: match[1] ?? "",
    lens: match[2] ?? "",
    stale: match[3] === "true",
  };
}
