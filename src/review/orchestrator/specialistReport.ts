import { z } from "zod";
import type { AppError } from "../../errors/appError.js";
import { MAX_SPECIALIST_FINDINGS } from "../../settings/index.js";
import { reviewFindingSchema, type ReviewFinding } from "../reviewSchema.js";

/** Fixed specialist roster, every run, in dispatch order (locked decision 4). */
export const SPECIALIST_IDS = ["correctness", "security", "quality", "tests"] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

const NOTES_MAX_CHARS = 4000;

/**
 * Structured report a specialist submits via `submit_findings_report`. Reuses the
 * canonical `reviewFindingSchema` — no duplicate finding shape. Empty is a first-class
 * success (`status: "no_findings"`), never inferred from a missing report.
 */
export const specialistReportSchema = z
  .object({
    status: z.enum(["findings", "no_findings"]),
    findings: z.array(reviewFindingSchema).max(MAX_SPECIALIST_FINDINGS).default([]),
    /** Optional investigation notes for orchestrator judgment; never published verbatim. */
    notes: z.string().max(NOTES_MAX_CHARS).optional(),
  })
  .superRefine((report, ctx) => {
    if (report.status === "findings" && report.findings.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "status 'findings' requires at least one finding",
        path: ["findings"],
      });
    }
    if (report.status === "no_findings" && report.findings.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "status 'no_findings' must not carry findings",
        path: ["findings"],
      });
    }
  });

export type SpecialistReport = z.infer<typeof specialistReportSchema>;

/** A specialist report that carries findings (narrowed from {@link SpecialistReport}). */
export type SpecialistFindingsReport = SpecialistReport & {
  status: "findings";
  findings: ReviewFinding[];
};

/**
 * The bounded outcome of one specialist run. `empty` is an explicit no-findings success
 * (silently skipped downstream); `error` means the run died, timed out, or exhausted its
 * validation repair after the fresh-session retry.
 */
export type SpecialistOutcome =
  | {
      specialist: SpecialistId;
      kind: "report";
      report: SpecialistFindingsReport;
      durationMs: number;
    }
  | { specialist: SpecialistId; kind: "empty"; durationMs: number }
  | { specialist: SpecialistId; kind: "error"; error: AppError; durationMs: number };
