import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import type { SpecialistId } from "./orchestratorTypes.js";

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

function formatValidationError(error: z.ZodError): string {
  return [
    "SpecialistBrief validation failed:",
    ...error.issues.map(
      (issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    ),
  ].join("\n");
}

export function buildSpecialistBriefTool(): {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
  readonly getBrief: () => SpecialistBrief | null;
} {
  let brief: SpecialistBrief | null = null;
  const piTool: PiTool = {
    name: "submit_specialist_brief",
    description: "Submit the structured specialist brief after completing PR reconnaissance.",
    parameters: z.toJSONSchema(specialistBriefSchema),
  };
  const executor: AgentRunnerToolExecutor = async (args) => {
    const parsed = specialistBriefSchema.safeParse(args);
    if (!parsed.success) {
      return { accepted: false, error: formatValidationError(parsed.error) };
    }
    brief = parsed.data;
    return { accepted: true };
  };

  return { piTool, executor, getBrief: () => brief };
}

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
