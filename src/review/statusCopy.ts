export const STATUS_WAITING = "⏸ Waiting";
export const STATUS_RUNNING = "⏳ Running";
export const STATUS_DONE = "✅ Done";
export const STATUS_NO_FINDINGS = "✅ No findings";
export const STATUS_FAILED = "⚠️ Failed";

export function statusFindings(count: number): string {
  if (count <= 0) return STATUS_NO_FINDINGS;
  return `✅ ${count} ${count === 1 ? "finding" : "findings"}`;
}

export function checkRunFindingsSummary(count: number): string {
  if (count <= 0) return "No findings";
  return `${count} ${count === 1 ? "finding" : "findings"}`;
}
