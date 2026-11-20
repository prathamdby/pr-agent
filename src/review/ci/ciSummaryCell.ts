import {
  escapeTableHtml,
  escapeTablePlainCell,
  renderTableEm,
  renderTableLink,
} from "../../github/markdownFormat.ts";
import {
  VERIFICATION_FAILURE_END,
  VERIFICATION_FAILURE_START,
  VERIFICATION_FAILURE_TEXT,
} from "../../settings/index.ts";
import type { CiFailureDetail, CiRollup, CiSummary } from "./ciFacts.ts";

export const CI_PROJECTION_FORMAT = 1;

const CI_SUMMARY_CELL_RE =
  /<!--\s*pr-agent:ci-summary((?:\s+\w+=[^\s]+)*)\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*-->/;

const CI_ACTION_MARKER_RE =
  /<!--\s*pr-agent:ci-action((?:\s+\w+=[^\s]+)*)\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-action\s*-->/;

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
  readonly supersededHead?: boolean;
};

export type CiProjectionBodyDecision =
  | { readonly kind: "reject" }
  | { readonly kind: "current" }
  | { readonly kind: "update" };

function attrsFromMatch(raw: string | undefined) {
  const attrs: Record<string, string> = {};
  if (raw == null || raw.length === 0)
    return ((pinnedReturn: Record<string, string>) => pinnedReturn)(attrs);
  for (const part of raw.trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    attrs[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return ((pinnedReturn: Record<string, string>) => pinnedReturn)(attrs);
}

function markerHeadVersion(attrs: Record<string, string>) {
  const versionRaw = attrs.v;
  const parsed = versionRaw != null ? Number(versionRaw) : 0;
  return ((pinnedReturn: { readonly head: string | null; readonly version: number }) =>
    pinnedReturn)({
    head: attrs.head ?? null,
    version: Number.isSafeInteger(parsed) ? parsed : 0,
  });
}

function parseFormatAttr(attrs: Record<string, string>) {
  const raw = attrs.fmt;
  if (raw == null) return ((pinnedReturn: number) => pinnedReturn)(0);
  const parsed = Number(raw);
  return ((pinnedReturn: number) => pinnedReturn)(
    Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0,
  );
}

export function parseCiSummaryMarker(body: string) {
  const match = CI_SUMMARY_CELL_RE.exec(body);
  if (match == null) return ((pinnedReturn: CiSummaryMarker | null) => pinnedReturn)(null);
  const attrs = attrsFromMatch(match[1]);
  return ((pinnedReturn: CiSummaryMarker | null) => pinnedReturn)({
    ...markerHeadVersion(attrs),
    format: parseFormatAttr(attrs),
  });
}

export function parseCiSummaryMarkerVersion(body: string) {
  const marker = parseCiSummaryMarker(body);
  return ((pinnedReturn: number | null) => pinnedReturn)(marker == null ? null : marker.version);
}

export function renderCiActionPhrase(phrase: string, format = CI_PROJECTION_FORMAT) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:ci-action fmt=${format} -->${phrase}<!-- /pr-agent:ci-action -->`,
  );
}

export function decideCiProjectionBodyUpdate(
  body: string,
  headSha: string,
  version: number,
  options?: CiProjectionBodyOptions,
) {
  const marker = parseCiSummaryMarker(body);
  if (marker == null)
    return ((pinnedReturn: CiProjectionBodyDecision) => pinnedReturn)({ kind: "reject" });
  if (marker.head != null && marker.head !== headSha) {
    return ((pinnedReturn: CiProjectionBodyDecision) => pinnedReturn)(
      options?.supersededHead === true ? { kind: "update" } : { kind: "reject" },
    );
  }
  if (marker.version > version)
    return ((pinnedReturn: CiProjectionBodyDecision) => pinnedReturn)({ kind: "reject" });
  if (marker.version < version)
    return ((pinnedReturn: CiProjectionBodyDecision) => pinnedReturn)({ kind: "update" });
  if (marker.format < CI_PROJECTION_FORMAT)
    return ((pinnedReturn: CiProjectionBodyDecision) => pinnedReturn)({ kind: "update" });
  const actionMatch = CI_ACTION_MARKER_RE.exec(body);
  if (actionMatch != null) {
    const actionFormat = parseFormatAttr(attrsFromMatch(actionMatch[1]));
    if (actionFormat < CI_PROJECTION_FORMAT)
      return ((pinnedReturn: CiProjectionBodyDecision) => pinnedReturn)({ kind: "update" });
  } else if (legacyActionCiPhraseSpan(body) != null) {
    return ((pinnedReturn: CiProjectionBodyDecision) => pinnedReturn)({ kind: "update" });
  }
  return ((pinnedReturn: CiProjectionBodyDecision) => pinnedReturn)({ kind: "current" });
}

function firstNoteAlertBody(body: string) {
  const startMatch = /^>\s*\[!NOTE\]\s*$/m.exec(body);
  if (startMatch == null || startMatch.index == null)
    return ((pinnedReturn: { readonly start: number; readonly end: number } | null) =>
      pinnedReturn)(null);
  const contentStart = startMatch.index + startMatch[0].length;
  const rest = body.slice(contentStart);
  const lineMatches = [...rest.matchAll(/^>.*$/gm)];
  if (lineMatches.length === 0)
    return ((pinnedReturn: { readonly start: number; readonly end: number } | null) =>
      pinnedReturn)(null);
  let end = contentStart;
  for (const line of lineMatches) {
    if (line.index == null) break;
    const absolute = contentStart + line.index;
    if (absolute > end + 1 && !body.slice(end, absolute).includes(">")) break;
    end = absolute + line[0].length;
  }
  return ((pinnedReturn: { readonly start: number; readonly end: number } | null) => pinnedReturn)({
    start: startMatch.index,
    end,
  });
}

function legacyActionCiPhraseSpan(body: string) {
  const note = firstNoteAlertBody(body);
  if (note == null)
    return ((
      pinnedReturn: {
        readonly start: number;
        readonly end: number;
        readonly phrase: string;
      } | null,
    ) => pinnedReturn)(null);
  const segment = body.slice(note.start, note.end);
  for (const phrase of KNOWN_REVIEW_ACTION_CI_PHRASES) {
    const idx = segment.indexOf(phrase);
    if (idx < 0) continue;
    return ((
      pinnedReturn: {
        readonly start: number;
        readonly end: number;
        readonly phrase: string;
      } | null,
    ) => pinnedReturn)({
      start: note.start + idx,
      end: note.start + idx + phrase.length,
      phrase,
    });
  }
  return ((
    pinnedReturn: { readonly start: number; readonly end: number; readonly phrase: string } | null,
  ) => pinnedReturn)(null);
}

function replaceActionPhrase(body: string, phrase: string) {
  const marked = renderCiActionPhrase(phrase);
  if (CI_ACTION_MARKER_RE.test(body)) {
    return ((pinnedReturn: string) => pinnedReturn)(body.replace(CI_ACTION_MARKER_RE, marked));
  }
  const legacy = legacyActionCiPhraseSpan(body);
  if (legacy == null) return ((pinnedReturn: string) => pinnedReturn)(body);
  return ((pinnedReturn: string) => pinnedReturn)(
    `${body.slice(0, legacy.start)}${marked}${body.slice(legacy.end)}`,
  );
}

export type ApplyCiProjectionBodyResult = {
  readonly body: string;
  readonly kind: "updated" | "current";
};

export function applyCiProjectionBodyUpdate(
  body: string,
  nextCell: string,
  headSha: string,
  version: number,
  options?: CiProjectionBodyOptions & { readonly actionPhrase?: string | null },
) {
  const decision = decideCiProjectionBodyUpdate(body, headSha, version, options);
  if (decision.kind === "reject")
    return ((pinnedReturn: ApplyCiProjectionBodyResult | null) => pinnedReturn)(null);
  if (decision.kind === "current")
    return ((pinnedReturn: ApplyCiProjectionBodyResult | null) => pinnedReturn)({
      body,
      kind: "current",
    });

  let next = body.replace(CI_SUMMARY_CELL_RE, nextCell);
  if (options?.actionPhrase != null && options.actionPhrase.length > 0) {
    next = replaceActionPhrase(next, options.actionPhrase);
  }
  return ((pinnedReturn: ApplyCiProjectionBodyResult | null) => pinnedReturn)(
    next === body ? { body, kind: "current" } : { body: next, kind: "updated" },
  );
}

export function formatReviewActionLineCiStatus(summary: CiSummary | null | undefined) {
  switch (summary?.status) {
    case "passing":
      return ((pinnedReturn: string) => pinnedReturn)("CI is passing");
    case "failing":
      return ((pinnedReturn: string) => pinnedReturn)("CI is failing");
    case "pending":
      return ((pinnedReturn: string) => pinnedReturn)("CI is pending");
    case "unavailable":
      return ((pinnedReturn: string) => pinnedReturn)("CI is unavailable");
    case "none":
      return ((pinnedReturn: string) => pinnedReturn)("No CI checks ran on this head");
    default:
      return ((pinnedReturn: string) => pinnedReturn)("CI has not started");
  }
}

export function renderReviewActionLineCiStatus(summary: CiSummary | null | undefined) {
  return ((pinnedReturn: string) => pinnedReturn)(
    renderCiActionPhrase(formatReviewActionLineCiStatus(summary)),
  );
}

export const CI_SUMMARY_CELL_START = "<!-- pr-agent:ci-summary -->";
export const CI_SUMMARY_CELL_END = "<!-- /pr-agent:ci-summary -->";

export type CiSummarySections = {
  readonly headline: string;
  readonly failures: readonly CiFailureDetail[];
  readonly permissionNote?: string;
};

export function selectCiSummarySections(summary: CiSummary) {
  const failures =
    summary.status === "failing" && summary.failures.length > 0 ? [...summary.failures] : [];
  const permissionNote = summary.permissionNote?.trim();
  return ((pinnedReturn: CiSummarySections) => pinnedReturn)({
    headline: summary.headline,
    failures,
    ...(permissionNote != null && permissionNote.length > 0 ? { permissionNote } : {}),
  });
}

export function formatCiSummaryPlainText(summary: CiSummary) {
  const sections = selectCiSummarySections(summary);
  const parts: string[] = [sections.headline];
  for (const failure of sections.failures) {
    const lines = [failure.name];
    if (failure.url != null && failure.url.length > 0) {
      lines.push(failure.url);
    }
    lines.push(failure.reason, failure.fixHint);
    parts.push(lines.join("\n"));
  }
  if (sections.permissionNote != null) {
    parts.push(sections.permissionNote);
  }
  return ((pinnedReturn: string) => pinnedReturn)(parts.join("\n\n"));
}

export function renderCiSummaryCell(summary: CiSummary, headSha?: string, version?: number) {
  const sections = selectCiSummarySections(summary);
  const parts: string[] = [escapeTablePlainCell(sections.headline)];
  for (const failure of sections.failures) {
    const nameHtml =
      failure.url != null
        ? renderTableLink(failure.name, failure.url)
        : `<strong>${escapeTableHtml(failure.name)}</strong>`;
    parts.push(
      `${nameHtml}<br>${escapeTablePlainCell(failure.reason)}<br>${renderTableEm(failure.fixHint)}`,
    );
  }
  if (sections.permissionNote != null) {
    parts.push(renderTableEm(sections.permissionNote));
  }
  const inner = parts.join("<br><br>");
  let start = CI_SUMMARY_CELL_START;
  if (headSha != null && headSha.length > 0) {
    start =
      version != null
        ? `<!-- pr-agent:ci-summary head=${headSha} v=${version} fmt=${CI_PROJECTION_FORMAT} -->`
        : `<!-- pr-agent:ci-summary head=${headSha} fmt=${CI_PROJECTION_FORMAT} -->`;
  }
  return ((pinnedReturn: string) => pinnedReturn)(`${start}${inner}${CI_SUMMARY_CELL_END}`);
}

export type RenderableCiSummary = CiSummary & {
  readonly status: "passing" | "failing" | "pending" | "unavailable" | "none";
};

export function shouldRenderCiSummaryRow(
  summary: CiSummary | null | undefined,
): summary is RenderableCiSummary {
  if (summary == null) return false;
  return (
    summary.status === "passing" ||
    summary.status === "failing" ||
    summary.status === "pending" ||
    summary.status === "unavailable" ||
    summary.status === "none"
  );
}

export function shouldIncludeCiInAgentFixPrompt(
  summary: CiSummary | null | undefined,
): summary is Exclude<RenderableCiSummary, { status: "none" }> {
  return shouldRenderCiSummaryRow(summary) && summary.status !== "none";
}

const CI_ROLLUP_RE =
  /<!--\s*pr-agent:ci-rollup((?:\s+\w+=[^\s]+)*)\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-rollup\s*-->/;

export type CiRollupMarker = {
  readonly head: string | null;
  readonly version: number;
};

export function renderCiRollupMarker(headSha: string, version: number, rollup: CiRollup) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:ci-rollup head=${headSha} v=${version} -->${rollup}<!-- /pr-agent:ci-rollup -->`,
  );
}

export function parseCiRollupMarker(body: string) {
  const match = CI_ROLLUP_RE.exec(body);
  if (match == null) return ((pinnedReturn: CiRollupMarker | null) => pinnedReturn)(null);
  const attrs = attrsFromMatch(match[1]);
  return ((pinnedReturn: CiRollupMarker | null) => pinnedReturn)(markerHeadVersion(attrs));
}

export function shouldReplaceCiRollupMarker(body: string, headSha: string, version: number) {
  const marker = parseCiRollupMarker(body);
  if (marker == null) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (marker.head != null && marker.head !== headSha)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(marker.version < version);
}

export function replaceCiRollupMarkerIfNewer(
  body: string,
  nextMarker: string,
  headSha: string,
  version: number,
) {
  if (!shouldReplaceCiRollupMarker(body, headSha, version))
    return ((pinnedReturn: string | null) => pinnedReturn)(null);
  const next = body.replace(CI_ROLLUP_RE, nextMarker);
  return ((pinnedReturn: string | null) => pinnedReturn)(next === body ? null : next);
}

export type VerificationFailureSurface = "ci_cell" | "stub_line";

export function renderVerificationFailureBlock() {
  return ((pinnedReturn: string) => pinnedReturn)(
    `${VERIFICATION_FAILURE_START}${VERIFICATION_FAILURE_TEXT}${VERIFICATION_FAILURE_END}`,
  );
}

export function injectVerificationFailureIntoCiCell(body: string, block: string) {
  if (body.includes(VERIFICATION_FAILURE_START) || !CI_SUMMARY_CELL_RE.test(body))
    return ((pinnedReturn: string) => pinnedReturn)(body);
  return ((pinnedReturn: string) => pinnedReturn)(
    body.replace(CI_SUMMARY_CELL_END, `${block}${CI_SUMMARY_CELL_END}`),
  );
}
