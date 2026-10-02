const PROGRESS_REVISION_RE =
  /<!--\s*pr-agent:progress-revision(?:\s+workItemId=([^\s]+)\s+value=|\s+)(\d+)\s*-->/;

export function renderProgressRevisionComment(revision: number, workItemId?: string): string {
  return workItemId == null
    ? `<!-- pr-agent:progress-revision ${revision} -->`
    : `<!-- pr-agent:progress-revision workItemId=${encodeURIComponent(workItemId)} value=${revision} -->`;
}

export function parseProgressRevision(body: string): number | null {
  return parseProgressRevisionState(body)?.revision ?? null;
}

export function withProgressRevisionComment(
  body: string,
  revision: number,
  workItemId?: string,
): string {
  const withoutRevision = body.replace(PROGRESS_REVISION_RE, "").trimEnd();
  return `${withoutRevision}\n${renderProgressRevisionComment(revision, workItemId)}`;
}

export function parseProgressRevisionState(
  body: string,
): { readonly revision: number; readonly workItemId?: string } | null {
  const match = PROGRESS_REVISION_RE.exec(body);
  if (!match?.[2]) return null;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision)) return null;
  if (match[1] == null) return { revision };
  try {
    return { revision, workItemId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}
