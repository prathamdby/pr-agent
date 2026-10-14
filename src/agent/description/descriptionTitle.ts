import { DESCRIPTION_TITLE_MAX_LENGTH } from "../../settings/index.js";

const CONVENTIONAL_TYPE_PREFIX =
  /^(?:feat|fix|docs|chore|refactor|test|perf|style|ci|build|revert)(?:\([^)]+\))?!?:\s+/i;

export function enforceDescriptionTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return trimmed;

  let normalized = trimmed.replace(CONVENTIONAL_TYPE_PREFIX, "").replace(/\.+$/, "").trim();
  if (normalized.length === 0) {
    normalized = trimmed.replace(/\.+$/, "").trim();
  }

  normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);

  if (normalized.length <= DESCRIPTION_TITLE_MAX_LENGTH) {
    return normalized;
  }

  const truncated = normalized.slice(0, DESCRIPTION_TITLE_MAX_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > DESCRIPTION_TITLE_MAX_LENGTH * 0.5) {
    return truncated.slice(0, lastSpace).trim();
  }
  return truncated.trim();
}
