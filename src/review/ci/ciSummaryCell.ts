/** Current CI projection marker format. Unknown attrs stay backward-readable. */
export const CI_PROJECTION_FORMAT = 1;

const CI_SUMMARY_CELL_RE =
  /<!--\s*pr-agent:ci-summary((?:\s+\w+=[^\s]+)*)\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*-->/;

const CI_ACTION_MARKER_RE =
  /<!--\s*pr-agent:ci-action((?:\s+\w+=[^\s]+)*)\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-action\s*-->/;

/** Known completed-review action-line CI phrases, longest first for bounded legacy repair. */
export const KNOWN_REVIEW_ACTION_CI_PHRASES = [
  "No CI checks ran on this head",
  "CI has not started",
  "CI is unavailable",
  "CI is pending",
  "CI is passing",
  "CI is failing",
] as const;

export type CiSummaryMarker = {
  readonly head: string | null;
  readonly version: number;
  readonly format: number;
};

export type CiProjectionBodyOptions = {
  /** Caller confirmed `headSha` is the PR head, so a marker on another head is superseded. */
  readonly supersededHead?: boolean;
};

export type CiProjectionBodyDecision =
  | { readonly kind: "reject" }
  | { readonly kind: "current" }
  | { readonly kind: "update" };

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

function parseFormatAttr(attrs: Record<string, string>): number {
  const raw = attrs.fmt;
  if (raw == null) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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
    format: parseFormatAttr(attrs),
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

export function renderCiActionPhrase(phrase: string, format = CI_PROJECTION_FORMAT): string {
  return `<!-- pr-agent:ci-action fmt=${format} -->${phrase}<!-- /pr-agent:ci-action -->`;
}

export function decideCiProjectionBodyUpdate(
  body: string,
  headSha: string,
  version: number,
  options?: CiProjectionBodyOptions,
): CiProjectionBodyDecision {
  const marker = parseCiSummaryMarker(body);
  if (marker == null) return { kind: "reject" };
  if (marker.head != null && marker.head !== headSha) {
    return options?.supersededHead === true ? { kind: "update" } : { kind: "reject" };
  }
  if (marker.version > version) return { kind: "reject" };
  if (marker.version < version) return { kind: "update" };
  if (marker.format < CI_PROJECTION_FORMAT) return { kind: "update" };
  const actionMatch = CI_ACTION_MARKER_RE.exec(body);
  if (actionMatch != null) {
    const actionFormat = parseFormatAttr(attrsFromMatch(actionMatch[1]));
    if (actionFormat < CI_PROJECTION_FORMAT) return { kind: "update" };
  } else if (legacyActionCiPhraseSpan(body) != null) {
    return { kind: "update" };
  }
  return { kind: "current" };
}

/** True when the comment cell should receive this head revision / format. */
export function shouldReplaceCiSummaryCell(
  body: string,
  headSha: string,
  version: number,
): boolean {
  return decideCiProjectionBodyUpdate(body, headSha, version).kind === "update";
}

function firstNoteAlertBody(body: string): { readonly start: number; readonly end: number } | null {
  const startMatch = /^>\s*\[!NOTE\]\s*$/m.exec(body);
  if (startMatch == null || startMatch.index == null) return null;
  const contentStart = startMatch.index + startMatch[0].length;
  const rest = body.slice(contentStart);
  const lineMatches = [...rest.matchAll(/^>.*$/gm)];
  if (lineMatches.length === 0) return null;
  let end = contentStart;
  for (const line of lineMatches) {
    if (line.index == null) break;
    const absolute = contentStart + line.index;
    if (absolute > end + 1 && !body.slice(end, absolute).includes(">")) break;
    end = absolute + line[0].length;
  }
  return { start: startMatch.index, end };
}

function legacyActionCiPhraseSpan(
  body: string,
): { readonly start: number; readonly end: number; readonly phrase: string } | null {
  const note = firstNoteAlertBody(body);
  if (note == null) return null;
  const segment = body.slice(note.start, note.end);
  for (const phrase of KNOWN_REVIEW_ACTION_CI_PHRASES) {
    const idx = segment.indexOf(phrase);
    if (idx < 0) continue;
    return {
      start: note.start + idx,
      end: note.start + idx + phrase.length,
      phrase,
    };
  }
  return null;
}

function replaceActionPhrase(body: string, phrase: string): string {
  const marked = renderCiActionPhrase(phrase);
  if (CI_ACTION_MARKER_RE.test(body)) {
    return body.replace(CI_ACTION_MARKER_RE, marked);
  }
  const legacy = legacyActionCiPhraseSpan(body);
  if (legacy == null) return body;
  return `${body.slice(0, legacy.start)}${marked}${body.slice(legacy.end)}`;
}

export type ApplyCiProjectionBodyResult = {
  readonly body: string;
  readonly kind: "updated" | "current";
};

/**
 * Replaces the marked CI cell (and optional completed-review action phrase) when
 * head matches (or the marker head is superseded) and the next revision/format is
 * allowed. The supplied `nextCell` is authoritative for verification-failure injection.
 */
export function applyCiProjectionBodyUpdate(
  body: string,
  nextCell: string,
  headSha: string,
  version: number,
  options?: CiProjectionBodyOptions & { readonly actionPhrase?: string | null },
): ApplyCiProjectionBodyResult | null {
  const decision = decideCiProjectionBodyUpdate(body, headSha, version, options);
  if (decision.kind === "reject") return null;
  if (decision.kind === "current") return { body, kind: "current" };

  let next = body.replace(CI_SUMMARY_CELL_RE, nextCell);
  if (options?.actionPhrase != null && options.actionPhrase.length > 0) {
    next = replaceActionPhrase(next, options.actionPhrase);
  }
  return next === body ? { body, kind: "current" } : { body: next, kind: "updated" };
}

/**
 * Replaces the marked CI cell when `head` matches and marker `v` / format allows.
 * Returns null when the cell is missing or the write would be a no-op.
 */
export function replaceCiSummaryCellIfNewer(
  body: string,
  nextCell: string,
  headSha: string,
  version: number,
  options?: { readonly actionPhrase?: string | null },
): string | null {
  const result = applyCiProjectionBodyUpdate(body, nextCell, headSha, version, options);
  if (result == null || result.kind === "current") return null;
  return result.body;
}
