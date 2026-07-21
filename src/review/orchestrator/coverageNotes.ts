import { JUDGMENT_DEGRADED_NOTE, RUN_DEADLINE_NOTE } from "../../settings/index.js";

/** Coverage / degrade notes for the review summary comment (decision 19 / 21 / deadline). */
export function coverageNotes(params: {
  readonly partialSpecialists: readonly string[];
  readonly judgmentDegraded: boolean;
  /** Pure time-budget path — never combined with judgment-degraded wording. */
  readonly deadlineReached?: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (params.partialSpecialists.length > 0) {
    parts.push(`Coverage partial: ${params.partialSpecialists.join(", ")} specialist(s) failed.`);
  }
  if (params.judgmentDegraded) {
    parts.push(JUDGMENT_DEGRADED_NOTE);
  } else if (params.deadlineReached) {
    parts.push(RUN_DEADLINE_NOTE);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
