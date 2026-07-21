import { escapeTableHtml } from "../../github/markdownFormat.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";

export type ReviewRunFooterMeta = {
  readonly durationMs: number;
  readonly model: string;
};

const FOOTER_SEP = " ⋅ ";

export function reviewLensFooterLabel(_mode: AnyReviewLens): string {
  return "general";
}

/** Compact wall-clock duration (`45s`, `11m 20s`, `1h 2m`). */
export function formatReviewDuration(durationMs: number): string {
  const totalSeconds = Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/** Normalized 7–40 hex SHA, or null when invalid. */
export function normalizeGitHeadSha(headSha: string): string | null {
  const normalized = headSha.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(normalized) ? normalized : null;
}

export function shortHeadSha(headSha: string): string {
  return normalizeGitHeadSha(headSha)?.slice(0, 7) ?? "unknown";
}

/** Muted provenance line: `<sub>a1b2c3d ⋅ general ⋅ 11m 20s ⋅ grok-4.5</sub>`. */
export function renderReviewRunFooter(params: {
  readonly headSha: string;
  readonly mode: AnyReviewLens;
  readonly durationMs: number;
  readonly model: string;
}): string {
  const parts = [
    shortHeadSha(params.headSha),
    reviewLensFooterLabel(params.mode),
    formatReviewDuration(params.durationMs),
    params.model.trim() || "unknown",
  ].map((part) => escapeTableHtml(part));
  return `<sub>${parts.join(FOOTER_SEP)}</sub>`;
}
