import { escapeTableHtml } from "../../github/markdownFormat.ts";

export type ReviewRunFooterMeta = {
  readonly durationMs: number;
  readonly model: string;
};

const FOOTER_SEP = " ⋅ ";

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

export function resolveReviewWallClockMs(params: {
  readonly stubPostedAtMs?: number | null | undefined;
  readonly metricsStartedAtMs: number | null | undefined;
  readonly endedAtMs: number;
}): number {
  const endedAtMs = Number.isFinite(params.endedAtMs) ? params.endedAtMs : 0;
  const startedAtMs = finiteTimestampMs(params.metricsStartedAtMs) ?? endedAtMs;
  return Math.max(0, endedAtMs - startedAtMs);
}

function finiteTimestampMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeGitHeadSha(headSha: string): string | null {
  const normalized = headSha.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(normalized) ? normalized : null;
}

export function shortHeadSha(headSha: string): string {
  return normalizeGitHeadSha(headSha)?.slice(0, 7) ?? "unknown";
}

export function renderReviewRunFooter(params: {
  readonly headSha: string;
  readonly durationMs: number;
  readonly model: string;
}): string {
  const parts = [
    shortHeadSha(params.headSha),
    "general",
    formatReviewDuration(params.durationMs),
    params.model.trim() || "unknown",
  ].map((part) => escapeTableHtml(part));
  return `<sub>${parts.join(FOOTER_SEP)}</sub>`;
}
