export const findingDetailFieldContract =
  "detail (required): two or three short sentences that state the trigger, the observable consequence, the line that proves it, the rule or invariant it breaks, and any unconfirmed step. Use one clause each. Leave out quoted code, restated diffs, tool-use explanations, and the fix direction that belongs in fixPrompt.";

export const fixPromptFieldContract =
  "fixPrompt (required on every finding, P3 included): one or two sentences naming the defect and the direction of the fix. `/triage` hands this text to an autofix agent, so it must stand alone. The server adds the file and line header, so leave those out.";

export const suggestedCodeAndConfidenceFieldContract = [
  "suggestedCode (optional): the exact replacement for the anchored startLine..endLine lines. GitHub applies it as a suggestion over exactly those lines, so leave it out when the fix touches other lines or only part of the range.",
  "confidence: integer 1-5 for how well the evidence you read supports the finding. 5 means the failure is traced end to end in reviewed-head code; 2 means the trigger is plausible but a step is unconfirmed. Judgment uses it to weigh the finding, so name the unconfirmed step in one clause of `detail`.",
].join("\n- ");

export const categoryFieldContract = [
  "category (optional): bug | security | performance | style, the primary issue type, used for filtering and labels.",
  "bug is a correctness defect, security a vulnerability, performance a measurable regression, style a formatting-only issue.",
].join("\n- ");

export const specialistFindingsReportContract = [
  "## Findings report",
  "The server reads only the `submit_findings_report` call, so the investigation ends with that call.",
  "Findings must cite lines that a read in this session returned. When a submitted finding cites unread lines, the tool result lists it as dropped. Read those lines and submit the complete report again, or leave the finding out if the lines do not support it.",
  "Anchor each finding's `file` and line range on a commentable line of a changed path when possible, so the server can open an inline review thread. A coverage or missing-test finding names the changed test, or the new test path the diff should add.",
  "Report every finding that meets this review's reporting gate, including lower-confidence ones with their confidence set honestly. The orchestrator re-judges every finding, so a missing real finding costs more than one that judgment drops.",
  'With at least one finding, use `status: "findings"`. With none, use `status: "no_findings"` and `findings: []`; that explicit empty report is a successful result.',
  "`notes` is optional context for orchestrator judgment, such as investigation limits. Findings belong in `findings`, because notes are never published.",
].join("\n");

export const reviewPayloadPerFindingContracts = [
  findingDetailFieldContract,
  fixPromptFieldContract,
  suggestedCodeAndConfidenceFieldContract,
  categoryFieldContract,
]
  .map((line) => `- ${line}`)
  .join("\n");

export const noToolsTurnGuidance =
  "This turn has no tools. The server parses your reply as JSON, so reply with only the JSON object described below.";
