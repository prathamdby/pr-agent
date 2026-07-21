import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { SPECIALIST_DISPLAY_LABEL, type SpecialistId } from "./specialistReport.js";

const BRIEF_TOOL_NAME = "submit_specialist_brief";

export const specialistBriefSchema = z.object({
  prIntent: z.string().min(1).max(2000),
  architectureNotes: z.string().max(6000),
  riskAreas: z
    .array(
      z.object({
        area: z.string().max(200),
        files: z.array(z.string()).max(20),
        reason: z.string().max(500),
      }),
    )
    .max(12),
  fileMap: z.string().max(6000),
  specialistFocus: z.object({
    correctness: z.string().max(1500),
    security: z.string().max(1500),
    quality: z.string().max(1500),
    tests: z.string().max(1500),
  }),
});

export type SpecialistBrief = z.infer<typeof specialistBriefSchema>;

const BRIEF_TOOL_PARAMETERS = z.toJSONSchema(specialistBriefSchema, {
  unrepresentable: "any",
}) as PiTool["parameters"];

function formatBriefValidationError(error: z.ZodError): string {
  const lines = [`${BRIEF_TOOL_NAME} validation failed:`];
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    lines.push(`- ${path}: ${issue.message}`);
  }
  lines.push("Resubmit a complete specialist brief matching the schema caps.");
  return lines.join("\n");
}

/**
 * Render the shared recon brief plus only the addressed specialist's focus line.
 * This is the follow-up user message of the two-prompt warm-up for `runSpecialist`.
 */
export function renderBriefMessage(brief: SpecialistBrief, specialist: SpecialistId): string {
  const riskLines =
    brief.riskAreas.length === 0
      ? ["(none listed)"]
      : brief.riskAreas.map((risk) => {
          const files = risk.files.length > 0 ? risk.files.join(", ") : "(no files)";
          return `- ${risk.area}: ${risk.reason} [${files}]`;
        });

  return [
    "# Specialist brief",
    "",
    "## PR intent",
    brief.prIntent,
    "",
    "## Architecture notes",
    brief.architectureNotes.length > 0 ? brief.architectureNotes : "(none)",
    "",
    "## Risk areas",
    ...riskLines,
    "",
    "## File map",
    brief.fileMap.length > 0 ? brief.fileMap : "(none)",
    "",
    `## Your focus (${SPECIALIST_DISPLAY_LABEL[specialist]})`,
    brief.specialistFocus[specialist],
  ].join("\n");
}

/** Zod-validated brief capture tool for the orchestrator recon turn. */
export function buildSpecialistBriefTool(): {
  piTool: PiTool;
  executor: AgentRunnerToolExecutor;
  getBrief: () => SpecialistBrief | null;
  getLastError: () => string | null;
  clearLastError: () => void;
} {
  let brief: SpecialistBrief | null = null;
  let lastError: string | null = null;

  const piTool: PiTool = {
    name: BRIEF_TOOL_NAME,
    description: [
      "Submit the structured specialist brief exactly once after recon.",
      "Include PR intent, architecture notes, risk areas, file map, and per-specialist focus lines.",
      "Byte caps keep the brief under context limits for the specialist warm-up.",
    ].join(" "),
    parameters: BRIEF_TOOL_PARAMETERS,
  };

  const executor: AgentRunnerToolExecutor = async (args) => {
    const parsed = specialistBriefSchema.safeParse(args);
    if (!parsed.success) {
      lastError = formatBriefValidationError(parsed.error);
      return { accepted: false, error: lastError };
    }
    brief = parsed.data;
    lastError = null;
    return { accepted: true };
  };

  return {
    piTool,
    executor,
    getBrief: () => brief,
    getLastError: () => lastError,
    clearLastError: () => {
      lastError = null;
    },
  };
}

/** Default focus lines used when recon falls back to a deterministic brief. */
export const DEFAULT_SPECIALIST_FOCUS: Record<SpecialistId, string> = {
  correctness: "Hunt evidenced correctness bugs with a reachable trigger path in the changed code.",
  security: "Hunt evidenced security defects where the diff touches dangerous API families.",
  quality: "Hunt evidenced maintainability and contract defects that will bite the next change.",
  tests: "Propose missing or weak tests for risky changed behavior; do not invent style nits.",
};
