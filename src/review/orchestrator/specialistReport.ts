import * as v from "valibot";
import { MAX_SPECIALIST_FINDINGS } from "../../settings/index.js";
import { reviewFindingSchema } from "../reviewSchema.js";

export const specialistReportSchema = v.pipe(
  v.object({
    status: v.picklist(["findings", "no_findings"]),
    findings: v.optional(
      v.pipe(v.array(reviewFindingSchema), v.maxLength(MAX_SPECIALIST_FINDINGS)),
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
