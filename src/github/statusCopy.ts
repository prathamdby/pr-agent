/** Shared GitHub status phrases (icons + sentence case). Layout stays per surface. */

export const STATUS_WAITING = "⏸ Waiting";
export const STATUS_RUNNING = "⏳ Running";
export const STATUS_DONE = "✅ Done";
export const STATUS_NO_FINDINGS = "✅ No findings";
export const STATUS_FAILED = "⚠️ Failed";

/** Counted findings for progress ticks. Zero maps to the clean empty state. */
export function statusFindings(count: number): string {
  if (count <= 0) return STATUS_NO_FINDINGS;
  return `✅ ${count} ${count === 1 ? "finding" : "findings"}`;
}

/** Plain text (no emoji) for GitHub Checks summary lines. */
export function checkRunFindingsSummary(count: number): string {
  if (count <= 0) return "No findings";
  return `${count} ${count === 1 ? "finding" : "findings"}`;
}
