import {
  extractVerificationFailureBlock,
  injectVerificationFailureIntoCiCell,
} from "./verificationFailureBlock.js";

const CI_SUMMARY_CELL_RE =
  /<!--\s*pr-agent:ci-summary((?:\s+\w+=[^\s]+)*)\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*-->/;

export type CiSummaryMarker = {
  readonly head: string | null;
  readonly version: number;
};

function attrsFromMatch(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (raw == null || raw.length === 0) return attrs;
  for (const part of raw.trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    attrs[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return attrs;
}

export function parseCiSummaryMarker(body: string): CiSummaryMarker | null {
  const match = CI_SUMMARY_CELL_RE.exec(body);
  if (match == null) return null;
  const attrs = attrsFromMatch(match[1]);
  const versionRaw = attrs.v;
  const parsed = versionRaw != null ? Number(versionRaw) : 0;
  return {
    head: attrs.head ?? null,
    version: Number.isSafeInteger(parsed) ? parsed : 0,
  };
}

export function parseCiSummaryMarkerHead(body: string): string | null {
  return parseCiSummaryMarker(body)?.head ?? null;
}

export function parseCiSummaryMarkerVersion(body: string): number | null {
  const marker = parseCiSummaryMarker(body);
  return marker == null ? null : marker.version;
}

export function commentBodyHasCiSummaryCell(body: string): boolean {
  return CI_SUMMARY_CELL_RE.test(body);
}

/** True when the comment cell is for this head and its marker `v` is older than `version`. */
export function shouldReplaceCiSummaryCell(
  body: string,
  headSha: string,
  version: number,
): boolean {
  const marker = parseCiSummaryMarker(body);
  if (marker == null) return false;
  if (marker.head != null && marker.head !== headSha) return false;
  return marker.version < version;
}

/**
 * Replaces the marked CI cell when `head` matches and marker `v` is older.
 * Re-injects a verification-failure block already inside the cell.
 * Returns null when the cell is missing or the write would be a no-op.
 */
export function replaceCiSummaryCellIfNewer(
  body: string,
  nextCell: string,
  headSha: string,
  version: number,
): string | null {
  if (!shouldReplaceCiSummaryCell(body, headSha, version)) return null;
  const failure = extractVerificationFailureBlock(body);
  let cell = nextCell;
  if (failure != null) cell = injectVerificationFailureIntoCiCell(cell, failure);
  const next = body.replace(CI_SUMMARY_CELL_RE, cell);
  return next === body ? null : next;
}
