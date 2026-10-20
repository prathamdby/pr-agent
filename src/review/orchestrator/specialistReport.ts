import * as v from "valibot";
import { severityDefinitionText } from "../../prompts/shared/safety.ts";
import { MAX_SPECIALIST_FINDINGS } from "../../settings/index.ts";
import { reviewFindingEntries } from "../reviewSchema.ts";
import { CRITICAL_PATHS, TESTS_CLAIMS } from "./testsEvidence.ts";

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
    testsClaim: v.optional(
      v.pipe(
        v.picklist(TESTS_CLAIMS),
        v.description(
          "tests specialist only. coverage_gap names a missing test. invalidated_test names an existing test the change weakens.",
        ),
      ),
    ),
    testEvidence: v.optional(
      v.pipe(
        v.strictObject({
          searched: v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1))),
            v.minLength(1),
            v.maxLength(8),
            v.description("Queries searched before the coverage claim. One to eight."),
          ),
          read: v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1))),
            v.maxLength(16),
            v.description(
              "Workspace-relative paths read. Empty only when no candidate test exists.",
            ),
          ),
          gap: v.pipe(
            v.string(),
            v.minLength(1),
            v.description(
              "The missed neighbor. When read is empty, the shared no-candidate sentence.",
            ),
          ),
          criticalPath: v.optional(
            v.pipe(
              v.picklist(CRITICAL_PATHS),
              v.description(
                "Set when the untested neighbor is money, data integrity, or correctness.",
              ),
            ),
          ),
        }),
        v.description("Required for a tests coverage_gap finding. Omitted by other lenses."),
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
