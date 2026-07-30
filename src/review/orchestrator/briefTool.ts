import type { SpecialistId } from "./orchestratorTypes.js";

export type SpecialistBrief = {
  readonly prIntent: string;
  readonly architectureNotes: string;
  readonly riskAreas: readonly {
    readonly area: string;
    readonly files: readonly string[];
    readonly reason: string;
  }[];
  readonly fileMap: string;
  readonly specialistFocus: Readonly<Record<SpecialistId, string>>;
};

export function renderBriefMessage(brief: SpecialistBrief, specialist: SpecialistId): string {
  return [
    "Investigate this pull request using the specialist brief below.",
    "",
    "## PR intent",
    brief.prIntent,
    "",
    "## Architecture notes",
    brief.architectureNotes,
    "",
    "## Risk areas",
    ...brief.riskAreas.map(
      (risk) =>
        `- ${risk.area}\n  Files: ${risk.files.length > 0 ? risk.files.join(", ") : "(none)"}\n  Reason: ${risk.reason}`,
    ),
    "",
    "## File map",
    brief.fileMap,
    "",
    `## ${specialist} focus`,
    brief.specialistFocus[specialist],
  ].join("\n");
}
