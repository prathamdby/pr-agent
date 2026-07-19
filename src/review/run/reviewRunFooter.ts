import { escapeTableHtml } from "../../github/markdownFormat.js";
import type { ReviewMode } from "../reviewSchema.js";

export type ReviewRunFooterMeta = {
  readonly durationMs: number;
  readonly model: string;
};

const FOOTER_SEP = " ⋅ ";

export function reviewLensFooterLabel(mode: ReviewMode): string {
  switch (mode) {
    case "review":
      return "general";
    case "review-security":
      return "security";
    case "review-quality":
      return "quality";
    case "review-tests":
      return "tests";
  }
  const exhaustive: never = mode;
  return exhaustive;
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

export function shortHeadSha(headSha: string): string {
  const normalized = headSha.trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(normalized)) {
    return normalized.slice(0, 7);
  }
  return "unknown";
}

/** Muted provenance line: `<sub>a1b2c3d ⋅ general ⋅ 11m 20s ⋅ grok-4.5</sub>`. */
export function renderReviewRunFooter(params: {
  readonly headSha: string;
  readonly mode: ReviewMode;
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
