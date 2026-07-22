import { z } from "zod";
import { MAX_SPECIALIST_FINDINGS } from "../../settings/index.js";
import { reviewFindingSchema } from "../reviewSchema.js";

export const specialistReportSchema = z
  .object({
    status: z.enum(["findings", "no_findings"]),
    findings: z.array(reviewFindingSchema).max(MAX_SPECIALIST_FINDINGS).default([]),
    notes: z.string().max(4000).optional(),
  })
  .superRefine((report, ctx) => {
    if (report.status === "findings" && report.findings.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "status 'findings' requires at least one finding",
      });
    }
    if (report.status === "no_findings" && report.findings.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "status 'no_findings' must not carry findings",
      });
    }
  });

export type SpecialistReport = z.infer<typeof specialistReportSchema>;
