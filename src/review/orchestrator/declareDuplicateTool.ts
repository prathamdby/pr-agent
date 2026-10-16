import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toToolParameters } from "../../agent/tools/toolParams.js";
import { parseToolInput } from "../../agent/tools/parseToolInput.js";
import { AppError } from "../../errors/appError.js";
import type { DuplicateCleanupRefusal } from "../findingIdentity/duplicateCleanup.js";
import { isFindingId } from "../findingIdentity/findingMarker.js";
import type { DeclaredDuplicate } from "../publish/reviewDuplicateCleanup.js";
import type { ReviewPublishSession } from "../publish/reviewPublishSession.js";
import { assertPhaseToolAllowed, type OrchestratorPhaseRef } from "./phaseToolPolicy.js";

const declareDuplicateSchema = v.object({
  findingIds: v.pipe(
    v.array(v.string()),
    v.minLength(2),
    v.maxLength(10),
    v.description("Open finding IDs from the finding inventory that describe one defect."),
  ),
  reason: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(500),
    v.description("Why these findings describe the same defect."),
  ),
});

const REFUSAL_GUIDANCE = {
  inventory_incomplete:
    "The finding inventory is incomplete this run, so the server cleans up no duplicates.",
  too_few: "Name at least two different finding IDs.",
  unknown_finding: "Every ID must come from the finding inventory.",
  not_open: "Every finding must still be open.",
  not_thread: "Every finding must be an inline review thread. Summary-only findings cannot merge.",
  comments_incomplete: "A thread has more comments than the server can read, so it stays as it is.",
  aliased: "A finding is already tracked as a duplicate of a finding outside this group.",
  different_file: "The findings sit in different files.",
  not_overlapping: "The findings do not sit on overlapping lines.",
} as const satisfies Record<DuplicateCleanupRefusal, string>;

export type DeclareDuplicateToolResult =
  | Extract<DeclaredDuplicate, { readonly kind: "accepted" }>
  | {
      readonly kind: "refused";
      readonly reason: DuplicateCleanupRefusal;
      readonly error: string;
    }
  | {
      readonly kind: "wrong_phase";
      readonly code: "review.tool_wrong_phase";
      readonly phase: string;
      readonly allowed: readonly string[];
      readonly error: string;
    };

export function buildDeclareDuplicateTool(params: {
  readonly phaseRef: OrchestratorPhaseRef;
  readonly session: ReviewPublishSession;
}): {
  readonly piTool: PiTool;
  readonly executor: (args: Record<string, unknown>) => Promise<DeclareDuplicateToolResult>;
} {
  const piTool: PiTool = {
    name: "declare_duplicate",
    description:
      "Declare that two or more open findings in the finding inventory describe the same defect. The server checks the group, keeps one thread as the canonical finding, links each copy to it, and resolves copies nobody has replied to. The server picks the canonical thread, so ID order does not matter.",
    parameters: toToolParameters(declareDuplicateSchema),
  };
  const executor = async (args: Record<string, unknown>): Promise<DeclareDuplicateToolResult> => {
    const gate = assertPhaseToolAllowed(params.phaseRef.current, "declare_duplicate");
    if (!gate.ok) {
      return {
        kind: "wrong_phase",
        code: gate.code,
        phase: gate.phase,
        allowed: gate.allowed,
        error: gate.error,
      };
    }
    const parsed = parseToolInput(declareDuplicateSchema, args, {
      toolName: "declare_duplicate",
      errorTitle: "declare_duplicate validation failed:",
    });
    if (!parsed.ok) {
      throw new AppError({
        domain: "review",
        kind: "declare_duplicate_validation_failed",
        message: parsed.error,
      });
    }
    const ids = parsed.value.findingIds;
    const findingIds = ids.filter(isFindingId);
    const declared: DeclaredDuplicate =
      findingIds.length === ids.length
        ? params.session.duplicateCleanup.declare(findingIds)
        : { kind: "refused", reason: "unknown_finding" };
    return declared.kind === "accepted"
      ? declared
      : { ...declared, error: REFUSAL_GUIDANCE[declared.reason] };
  };
  return { piTool, executor };
}
