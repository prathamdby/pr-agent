import * as v from "valibot";
import { AppError } from "../errors/appError.js";
import { LEGACY_REVIEW_LENSES, normalizeReviewLens } from "../settings/legacyReviewLenses.js";
import { isRecord } from "../util/typeGuards.js";
import type {
  AgentWorkItem,
  AgentWorkItemCore,
  AskWorkPayload,
  DescriptionWorkPayload,
  ReviewWorkPayload,
  StaleHeadReplacement,
  StaleHeadReplacementState,
  TriageWorkPayload,
  VerificationWorkPayload,
  WorkType,
} from "./types.js";

/** Dual-read current and deployed parent payloads for a replacement work-item id. */
export const STALE_HEAD_REPLACEMENT_ID_SQL = `COALESCE(
          payload->'staleHeadReplacement'->>'replacementWorkItemId',
          NULLIF(payload->>'staleHeadReplacementWorkItemId', '')
        )`;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asReplacementState(value: unknown): StaleHeadReplacementState | undefined {
  return value === "pending-enqueue" || value === "enqueued" ? value : undefined;
}

/** Normalize nested or legacy stale-head fields. Impossible fragments become absent. */
export function normalizeStaleHeadReplacement(raw: {
  readonly staleHeadRescheduled?: unknown;
  readonly staleHeadReplacement?: unknown;
  readonly staleHeadReplacementWorkItemId?: unknown;
  readonly staleHeadReplacementEnqueued?: unknown;
}): StaleHeadReplacement | undefined {
  const nested = isRecord(raw.staleHeadReplacement) ? raw.staleHeadReplacement : undefined;
  const nestedId = nonEmptyString(nested?.replacementWorkItemId);
  const legacyId = nonEmptyString(raw.staleHeadReplacementWorkItemId);
  // One-shot replacement rows copied the parent id; that is not parent lifecycle.
  const replacementWorkItemId =
    nestedId ?? (raw.staleHeadRescheduled === true ? undefined : legacyId);
  if (!replacementWorkItemId) return undefined;
  const state =
    asReplacementState(nested?.state) ??
    (raw.staleHeadReplacementEnqueued === true ? "enqueued" : "pending-enqueue");
  return { replacementWorkItemId, state };
}

const ReviewModeSchema = v.pipe(
  v.picklist(["review", ...LEGACY_REVIEW_LENSES]),
  v.transform(normalizeReviewLens),
);
const WorkSourceSchema = v.picklist(["auto", "slash"]);

const positiveInt = () => v.pipe(v.number(), v.integer(), v.gtValue(0));

const ReplyTargetSchema = v.variant("kind", [
  v.looseObject({
    kind: v.literal("prConversation"),
    prNumber: positiveInt(),
  }),
  v.looseObject({
    kind: v.literal("inlineReviewThread"),
    prNumber: positiveInt(),
    inReplyToCommentId: positiveInt(),
  }),
]);

const CodeAnchorSchema = v.looseObject({
  path: v.pipe(v.string(), v.minLength(1)),
  line: positiveInt(),
  startLine: v.optional(positiveInt()),
  side: v.optional(v.picklist(["LEFT", "RIGHT"])),
  diffHunk: v.optional(v.string()),
});

const AckTargetSchema = v.variant("kind", [
  v.looseObject({
    kind: v.literal("pr"),
    prNumber: positiveInt(),
  }),
  v.looseObject({
    kind: v.literal("issueComment"),
    commentId: positiveInt(),
  }),
  v.looseObject({
    kind: v.literal("reviewComment"),
    commentId: positiveInt(),
  }),
]);

const ReviewWorkPayloadFieldsSchema = v.looseObject({
  mode: ReviewModeSchema,
  source: WorkSourceSchema,
  repositorySizeKb: v.optional(v.number()),
  userSupplement: v.optional(v.string()),
  commenterId: v.optional(v.pipe(v.number(), v.integer())),
  ackTargets: v.optional(v.array(AckTargetSchema)),
  publishDegraded: v.optional(v.boolean()),
  staleHeadRescheduled: v.optional(v.boolean()),
  staleHeadReplacement: v.optional(v.unknown()),
  staleHeadReplacementWorkItemId: v.optional(v.unknown()),
  staleHeadReplacementEnqueued: v.optional(v.unknown()),
  cancelAttribution: v.optional(
    v.variant("kind", [
      v.object({ kind: v.literal("user"), login: v.pipe(v.string(), v.minLength(1)) }),
      v.object({ kind: v.literal("merged") }),
      v.object({ kind: v.literal("closed") }),
    ]),
  ),
});

const ReviewWorkPayloadSchema = v.pipe(
  ReviewWorkPayloadFieldsSchema,
  v.transform((input) => {
    const {
      staleHeadReplacement: _nested,
      staleHeadReplacementWorkItemId: _legacyId,
      staleHeadReplacementEnqueued: _legacyEnqueued,
      ...rest
    } = input;
    const staleHeadReplacement = normalizeStaleHeadReplacement(input);
    return staleHeadReplacement === undefined ? rest : { ...rest, staleHeadReplacement };
  }),
);

const AskWorkPayloadSchema = v.looseObject({
  question: v.string(),
  replyTarget: ReplyTargetSchema,
  repositorySizeKb: v.optional(v.number()),
  codeAnchor: v.optional(CodeAnchorSchema),
  commenterId: v.optional(v.pipe(v.number(), v.integer())),
  commentId: positiveInt(),
  ackTargets: v.optional(v.array(AckTargetSchema)),
});

const DescriptionWorkPayloadSchema = v.looseObject({
  source: WorkSourceSchema,
  repositorySizeKb: v.optional(v.number()),
  userSupplement: v.optional(v.string()),
  commenterId: v.optional(v.pipe(v.number(), v.integer())),
  ackTargets: v.optional(v.array(AckTargetSchema)),
});

const TriageWorkPayloadSchema = v.looseObject({
  source: v.literal("slash"),
  repositorySizeKb: v.optional(v.number()),
  commenterId: v.optional(v.pipe(v.number(), v.integer())),
  commentId: positiveInt(),
  scope: v.picklist(["all", "thread"]),
  threadAnchorCommentId: v.optional(positiveInt()),
  needsThreadRootResolution: v.optional(v.boolean()),
  replyTarget: ReplyTargetSchema,
  publishDegraded: v.optional(v.boolean()),
  ackTargets: v.optional(v.array(AckTargetSchema)),
  cancelAttribution: v.optional(
    v.variant("kind", [
      v.object({ kind: v.literal("user"), login: v.pipe(v.string(), v.minLength(1)) }),
      v.object({ kind: v.literal("merged") }),
      v.object({ kind: v.literal("closed") }),
    ]),
  ),
});

const VerificationWorkPayloadSchema = v.looseObject({
  source: v.literal("auto"),
  repositorySizeKb: v.optional(v.number()),
  pushBeforeSha: v.optional(v.pipe(v.string(), v.minLength(1))),
  ackTargets: v.optional(v.array(AckTargetSchema)),
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

function parseWithSchema<T>(
  workType: WorkType,
  schema: v.GenericSchema<unknown, T>,
  raw: unknown,
): T {
  const result = v.safeParse(schema, raw);
  if (!result.success) {
    const issue = result.issues[0];
    const detail = !issue
      ? "invalid payload"
      : `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`;
    throw new WorkItemPayloadValidationError(
      workType,
      `Invalid ${workType} work item payload: ${detail}`,
    );
  }
  return result.output;
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
