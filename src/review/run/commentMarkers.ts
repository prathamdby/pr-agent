const PROGRESS_REVISION_RE =
  /<!--\s*pr-agent:progress-revision(?:\s+workItemId=([^\s]+)\s+value=|\s+)(\d+)\s*-->/;

export function renderProgressRevisionComment(revision: number, workItemId?: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    workItemId == null
      ? `<!-- pr-agent:progress-revision ${revision} -->`
      : `<!-- pr-agent:progress-revision workItemId=${encodeURIComponent(workItemId)} value=${revision} -->`,
  );
}

export function withProgressRevisionComment(body: string, revision: number, workItemId?: string) {
  const withoutRevision = body.replace(PROGRESS_REVISION_RE, "").trimEnd();
  return ((pinnedReturn: string) => pinnedReturn)(
    `${withoutRevision}\n${renderProgressRevisionComment(revision, workItemId)}`,
  );
}

export function parseProgressRevisionState(body: string) {
  const match = PROGRESS_REVISION_RE.exec(body);
  if (!match?.[2])
    return ((pinnedReturn: { readonly revision: number; readonly workItemId?: string } | null) =>
      pinnedReturn)(null);
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision))
    return ((pinnedReturn: { readonly revision: number; readonly workItemId?: string } | null) =>
      pinnedReturn)(null);
  if (match[1] == null)
    return ((pinnedReturn: { readonly revision: number; readonly workItemId?: string } | null) =>
      pinnedReturn)({ revision });
  try {
    return ((pinnedReturn: { readonly revision: number; readonly workItemId?: string } | null) =>
      pinnedReturn)({ revision, workItemId: decodeURIComponent(match[1]) });
  } catch {
    return ((pinnedReturn: { readonly revision: number; readonly workItemId?: string } | null) =>
      pinnedReturn)(null);
  }
}

const REVIEW_META_RE =
  /<!--\s*pr-agent:review-meta\s+headSha=([^\s]+)\s+lens=([^\s]+)\s+stale=(true|false)\s*-->/;

export type ParsedReviewMeta = {
  readonly headSha: string;
  readonly lens: string;
  readonly stale: boolean;
};

export function parseReviewMetaFromCommentBody(body: string) {
  const match = body.match(REVIEW_META_RE);
  if (match == null) return ((pinnedReturn: ParsedReviewMeta | null) => pinnedReturn)(null);
  return ((pinnedReturn: ParsedReviewMeta | null) => pinnedReturn)({
    headSha: match[1] ?? "",
    lens: match[2] ?? "",
    stale: match[3] === "true",
  });
}
