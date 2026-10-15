export const MISSING_REPORT_ERROR =
  "No valid SpecialistReport was submitted. Call submit_findings_report with the complete report.";

export function renderSpecialistReportRepair(validationError: string): string {
  return [
    validationError,
    "Fix the report and call submit_findings_report now. This repair turn allows only a couple of tool calls, so submit from the evidence you already have.",
  ].join("\n\n");
}

export const rejectedFindingSubmissionGuidance =
  "A rejected submission returns the reasons; fix them and submit again.";
