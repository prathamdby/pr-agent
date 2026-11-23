export const MISSING_REPORT_ERROR =
  "No valid SpecialistReport was submitted. Call submit_findings_report with the complete report.";

export const SPECIALIST_WRAP_UP_STEER =
  "The investigation budget is nearly spent. Finish only the work needed to validate the findings already in flight within the remaining tool rounds, then call submit_findings_report with them. If none are validated, submit a report with status no_findings.";

export function renderSpecialistReportRepair(validationError: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      validationError,
      "Fix the report and call submit_findings_report now. This repair turn allows only a couple of tool calls, so submit from the evidence you already have.",
    ].join("\n\n"),
  );
}

export const rejectedFindingSubmissionGuidance =
  "A rejected submission returns the reasons; fix them and submit again.";
