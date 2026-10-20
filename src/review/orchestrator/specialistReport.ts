import * as v from "valibot";
import { severityDefinitionText } from "../../prompts/shared/safety.ts";
import { MAX_SPECIALIST_FINDINGS } from "../../settings/index.ts";
import { reviewFindingEntries } from "../reviewSchema.ts";

const {
  severity: _publishedSeverity,
  severityRationale: _severityRationale,
  ...specialistFindingEntries
} = reviewFindingEntries;

const specialistFindingSchema = v.pipe(
  v.object({
    ...specialistFindingEntries,
    suggestedSeverity: v.pipe(
      v.picklist(["P0", "P1", "P2", "P3"]),
      v.description(
        `Suggestion only. Judgment assigns the published severity. ${severityDefinitionText()}`,
      ),
    ),
  }),
  v.forward(
    v.check((finding) => finding.startLine <= finding.endLine, "startLine must be <= endLine"),
    ["endLine"],
  ),
  v.forward(
    v.check(
      (finding) => finding.fixPrompt.trim().length > 0,
      "fixPrompt is required for P0/P1/P2/P3 findings",
    ),
    ["fixPrompt"],
  ),
);

export const specialistReportSchema = v.pipe(
  v.object({
    status: v.picklist(["findings", "no_findings"]),
    findings: v.optional(
      v.pipe(v.array(specialistFindingSchema), v.maxLength(MAX_SPECIALIST_FINDINGS)),
      [],
    ),
    notes: v.optional(v.pipe(v.string(), v.maxLength(4000))),
  }),
  v.check(
    (report) => !(report.status === "findings" && report.findings.length === 0),
    "status 'findings' requires at least one finding",
  ),
  v.check(
    (report) => !(report.status === "no_findings" && report.findings.length > 0),
    "status 'no_findings' must not carry findings",
  ),
);

export type SpecialistReport = v.InferOutput<typeof specialistReportSchema>;
