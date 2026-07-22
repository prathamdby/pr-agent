import { z } from "zod";
import { AppError } from "../errors/appError.js";
import { LEGACY_REVIEW_LENSES, normalizeReviewLens } from "../settings/legacyReviewLenses.js";
import type {
  AgentWorkItem,
  AgentWorkItemCore,
  AskWorkPayload,
  DescriptionWorkPayload,
  ReviewWorkPayload,
  TriageWorkPayload,
  VerificationWorkPayload,
  WorkType,
} from "./types.js";

const ReviewModeSchema = z.enum(["review", ...LEGACY_REVIEW_LENSES]).transform(normalizeReviewLens);
const WorkSourceSchema = z.enum(["auto", "slash"]);

const ReplyTargetSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("prConversation"),
    prNumber: z.number().int().positive(),
  }),
  z.looseObject({
    kind: z.literal("inlineReviewThread"),
    prNumber: z.number().int().positive(),
    inReplyToCommentId: z.number().int().positive(),
  }),
]);

const CodeAnchorSchema = z.looseObject({
  path: z.string().min(1),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  diffHunk: z.string().optional(),
});

const AckTargetSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("pr"),
    prNumber: z.number().int().positive(),
  }),
  z.looseObject({
    kind: z.literal("issueComment"),
    commentId: z.number().int().positive(),
  }),
  z.looseObject({
    kind: z.literal("reviewComment"),
    commentId: z.number().int().positive(),
  }),
]);

const ReviewWorkPayloadSchema = z.looseObject({
  mode: ReviewModeSchema,
  source: WorkSourceSchema,
  repositorySizeKb: z.number().optional(),
  userSupplement: z.string().optional(),
  commenterId: z.number().int().optional(),
  ackTargets: z.array(AckTargetSchema).optional(),
  publishDegraded: z.boolean().optional(),
  staleHeadRescheduled: z.boolean().optional(),
  staleHeadReplacementWorkItemId: z.string().min(1).optional(),
  staleHeadReplacementEnqueued: z.boolean().optional(),
});

const AskWorkPayloadSchema = z.looseObject({
  question: z.string(),
  replyTarget: ReplyTargetSchema,
  repositorySizeKb: z.number().optional(),
  codeAnchor: CodeAnchorSchema.optional(),
  commenterId: z.number().int().optional(),
  commentId: z.number().int().positive(),
  ackTargets: z.array(AckTargetSchema).optional(),
});

const DescriptionWorkPayloadSchema = z.looseObject({
  source: WorkSourceSchema,
  repositorySizeKb: z.number().optional(),
  userSupplement: z.string().optional(),
  commenterId: z.number().int().optional(),
  ackTargets: z.array(AckTargetSchema).optional(),
});

const TriageWorkPayloadSchema = z.looseObject({
  source: z.literal("slash"),
  repositorySizeKb: z.number().optional(),
  commenterId: z.number().int().optional(),
  commentId: z.number().int().positive(),
  scope: z.enum(["all", "thread"]),
  threadAnchorCommentId: z.number().int().positive().optional(),
  needsThreadRootResolution: z.boolean().optional(),
  replyTarget: ReplyTargetSchema,
  publishDegraded: z.boolean().optional(),
  ackTargets: z.array(AckTargetSchema).optional(),
});

const VerificationWorkPayloadSchema = z.looseObject({
  source: z.literal("auto"),
  repositorySizeKb: z.number().optional(),
  pushBeforeSha: z.string().min(1).optional(),
  ackTargets: z.array(AckTargetSchema).optional(),
});

export class WorkItemPayloadValidationError extends AppError {
  readonly workType: WorkType;

  constructor(workType: WorkType, message: string) {
    super({
      code: "agent_work.invalid_payload",
      message,
      context: { workType },
    });
    this.name = "WorkItemPayloadValidationError";
    this.workType = workType;
  }
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid payload";
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}

function parseWithSchema<T>(workType: WorkType, schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new WorkItemPayloadValidationError(
      workType,
      `Invalid ${workType} work item payload: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function parseWorkItemPayload(type: "review", raw: unknown): ReviewWorkPayload;
export function parseWorkItemPayload(type: "ask", raw: unknown): AskWorkPayload;
export function parseWorkItemPayload(type: "description", raw: unknown): DescriptionWorkPayload;
export function parseWorkItemPayload(type: "triage", raw: unknown): TriageWorkPayload;
export function parseWorkItemPayload(type: "verification", raw: unknown): VerificationWorkPayload;
export function parseWorkItemPayload(
  type: WorkType,
  raw: unknown,
):
  | ReviewWorkPayload
  | AskWorkPayload
  | DescriptionWorkPayload
  | TriageWorkPayload
  | VerificationWorkPayload;
export function parseWorkItemPayload(
  type: WorkType,
  raw: unknown,
):
  | ReviewWorkPayload
  | AskWorkPayload
  | DescriptionWorkPayload
  | TriageWorkPayload
  | VerificationWorkPayload {
  switch (type) {
    case "review":
      return parseWithSchema(type, ReviewWorkPayloadSchema, raw);
    case "ask":
      return parseWithSchema(type, AskWorkPayloadSchema, raw);
    case "description":
      return parseWithSchema(type, DescriptionWorkPayloadSchema, raw);
    case "triage":
      return parseWithSchema(type, TriageWorkPayloadSchema, raw);
    case "verification":
      return parseWithSchema(type, VerificationWorkPayloadSchema, raw);
    default: {
      const exhaustive: never = type;
      throw new WorkItemPayloadValidationError(
        "review",
        `Unknown work item type: ${String(exhaustive)}`,
      );
    }
  }
}

export function attachWorkItemPayload<T extends WorkType>(
  core: Extract<AgentWorkItemCore, { type: T }>,
  raw: unknown,
): Extract<AgentWorkItem, { type: T }>;
export function attachWorkItemPayload(core: AgentWorkItemCore, raw: unknown): AgentWorkItem;
export function attachWorkItemPayload(core: AgentWorkItemCore, raw: unknown): AgentWorkItem {
  switch (core.type) {
    case "review":
      return { ...core, payload: parseWorkItemPayload("review", raw) };
    case "ask":
      return { ...core, payload: parseWorkItemPayload("ask", raw) };
    case "description":
      return { ...core, payload: parseWorkItemPayload("description", raw) };
    case "triage":
      return { ...core, payload: parseWorkItemPayload("triage", raw) };
    case "verification":
      return { ...core, payload: parseWorkItemPayload("verification", raw) };
    default: {
      const exhaustive: never = core;
      throw new WorkItemPayloadValidationError(
        "review",
        `Unknown work item core: ${String(exhaustive)}`,
      );
    }
  }
}
