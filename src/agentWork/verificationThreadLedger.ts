import { createPublishContext } from "./publishOnce.ts";
import type { Pool } from "pg";
import type { VerificationFailureSurface } from "../review/ci/ciSummaryCell.ts";
import { isUsableReviewTimestamp } from "../review/run/reviewPriorFeedback.ts";
import { VERIFICATION_PUBLISH_LENS } from "../settings/index.ts";
import { isRecord } from "../util/typeGuards.ts";

type VerificationThreadVerdict = "skipped" | "dismissed" | "fixed" | "already-resolved";

export type { VerificationFailureSurface };

export type VerificationFailureSignal = {
  readonly headSha: string;
  readonly commentId: number;
  readonly surface: VerificationFailureSurface;
};

export type VerificationObjectionJournalEntry = {
  readonly commentId: number;
  readonly updatedAt: string;
  readonly decision: "concede" | "hold" | "not_objection";
  readonly answerCommentId?: number;
};

export type VerificationThreadState = {
  readonly stubCommentId?: number;
  readonly lastVerdict: VerificationThreadVerdict;
  readonly lastHeadSha?: string;
  readonly terminal?: boolean;
  readonly completion?: VerificationThreadCompletion;
  readonly objections?: readonly VerificationObjectionJournalEntry[];
};

export type VerificationThreadCompletion = {
  readonly workItemId: string;
  readonly operationKey: string;
  readonly headSha: string;
  readonly verdict: VerificationThreadVerdict;
  readonly stubOutcome: "written" | "missing" | "not_required";
  readonly stubCommentId?: number;
  readonly resolutionOutcome: "resolved" | "not_required";
};

export type VerificationThreadLedger = {
  readonly threads: Readonly<Record<string, VerificationThreadState>>;
  readonly failureSignal?: VerificationFailureSignal;
};

const VERIFICATION_THREAD_ACTIONS_STEP = "verification_thread_actions" as const;

function isVerdict(value: unknown): value is VerificationThreadVerdict {
  return (
    value === "skipped" ||
    value === "dismissed" ||
    value === "fixed" ||
    value === "already-resolved"
  );
}

function parseFailureSurface(value: unknown) {
  switch (value) {
    case "ci_cell":
    case "stub_line":
      return ((pinnedReturn: VerificationFailureSurface | null) => pinnedReturn)(value);
    default:
      return ((pinnedReturn: VerificationFailureSurface | null) => pinnedReturn)(null);
  }
}

function parseFailureSignal(value: unknown) {
  if (!isRecord(value))
    return ((pinnedReturn: VerificationFailureSignal | undefined) => pinnedReturn)(undefined);
  const record = value;
  const surface = parseFailureSurface(record.surface);
  if (surface == null)
    return ((pinnedReturn: VerificationFailureSignal | undefined) => pinnedReturn)(undefined);
  if (typeof record.headSha !== "string" || record.headSha.length === 0)
    return ((pinnedReturn: VerificationFailureSignal | undefined) => pinnedReturn)(undefined);
  if (typeof record.commentId !== "number" || !Number.isInteger(record.commentId))
    return ((pinnedReturn: VerificationFailureSignal | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: VerificationFailureSignal | undefined) => pinnedReturn)({
    headSha: record.headSha,
    commentId: record.commentId,
    surface,
  });
}

function parseThreadState(value: unknown) {
  if (!isRecord(value))
    return ((pinnedReturn: VerificationThreadState | null) => pinnedReturn)(null);
  const record = value;
  if (!isVerdict(record.lastVerdict))
    return ((pinnedReturn: VerificationThreadState | null) => pinnedReturn)(null);
  const stubCommentId = record.stubCommentId;
  const lastHeadSha = record.lastHeadSha;
  const terminal = record.terminal;
  const completion = parseVerificationThreadCompletion(record.completion);
  const objections = parseObjectionJournal(record.objections);
  return ((pinnedReturn: VerificationThreadState | null) => pinnedReturn)({
    lastVerdict: record.lastVerdict,
    ...(typeof stubCommentId === "number" && Number.isInteger(stubCommentId)
      ? { stubCommentId }
      : {}),
    ...(typeof lastHeadSha === "string" ? { lastHeadSha } : {}),
    ...(terminal === true ? { terminal: true } : {}),
    ...(completion != null ? { completion } : {}),
    ...(objections != null ? { objections } : {}),
  });
}

function parseObjectionJournal(value: unknown) {
  if (!Array.isArray(value))
    return ((pinnedReturn: readonly VerificationObjectionJournalEntry[] | null) => pinnedReturn)(
      null,
    );
  const entries: VerificationObjectionJournalEntry[] = [];
  for (const item of value) {
    const parsed = parseObjectionEntry(item);
    if (parsed != null) entries.push(parsed);
  }
  return ((pinnedReturn: readonly VerificationObjectionJournalEntry[] | null) => pinnedReturn)(
    entries.length > 0 ? entries : null,
  );
}

function parseObjectionEntry(value: unknown) {
  if (!isRecord(value))
    return ((pinnedReturn: VerificationObjectionJournalEntry | null) => pinnedReturn)(null);
  const decision = value.decision;
  if (decision !== "concede" && decision !== "hold" && decision !== "not_objection")
    return ((pinnedReturn: VerificationObjectionJournalEntry | null) => pinnedReturn)(null);
  if (
    typeof value.commentId !== "number" ||
    !Number.isSafeInteger(value.commentId) ||
    value.commentId <= 0
  ) {
    return ((pinnedReturn: VerificationObjectionJournalEntry | null) => pinnedReturn)(null);
  }
  if (typeof value.updatedAt !== "string" || !isUsableReviewTimestamp(value.updatedAt))
    return ((pinnedReturn: VerificationObjectionJournalEntry | null) => pinnedReturn)(null);
  const answerCommentId = value.answerCommentId;
  if (answerCommentId != null) {
    if (decision === "not_objection")
      return ((pinnedReturn: VerificationObjectionJournalEntry | null) => pinnedReturn)(null);
    if (
      typeof answerCommentId !== "number" ||
      !Number.isSafeInteger(answerCommentId) ||
      answerCommentId <= 0
    ) {
      return ((pinnedReturn: VerificationObjectionJournalEntry | null) => pinnedReturn)(null);
    }
  }
  return ((pinnedReturn: VerificationObjectionJournalEntry | null) => pinnedReturn)({
    commentId: value.commentId,
    updatedAt: value.updatedAt,
    decision,
    ...(typeof answerCommentId === "number" ? { answerCommentId } : {}),
  });
}

function parseVerificationThreadCompletion(value: unknown) {
  if (!isRecord(value))
    return ((pinnedReturn: VerificationThreadCompletion | null) => pinnedReturn)(null);
  const record = value;
  if (
    typeof record.workItemId !== "string" ||
    record.workItemId.length === 0 ||
    typeof record.operationKey !== "string" ||
    !/^verification:thread:\d+$/.test(record.operationKey) ||
    typeof record.headSha !== "string" ||
    record.headSha.length === 0 ||
    !isVerdict(record.verdict) ||
    (record.stubOutcome !== "written" &&
      record.stubOutcome !== "missing" &&
      record.stubOutcome !== "not_required") ||
    (record.resolutionOutcome !== "resolved" && record.resolutionOutcome !== "not_required")
  )
    return ((pinnedReturn: VerificationThreadCompletion | null) => pinnedReturn)(null);
  const stubCommentId = record.stubCommentId;
  if (
    record.stubOutcome === "written" &&
    (typeof stubCommentId !== "number" ||
      !Number.isSafeInteger(stubCommentId) ||
      stubCommentId <= 0)
  )
    return ((pinnedReturn: VerificationThreadCompletion | null) => pinnedReturn)(null);
  return ((pinnedReturn: VerificationThreadCompletion | null) => pinnedReturn)({
    workItemId: record.workItemId,
    operationKey: record.operationKey,
    headSha: record.headSha,
    verdict: record.verdict,
    stubOutcome: record.stubOutcome,
    ...(record.stubOutcome === "written" && typeof stubCommentId === "number"
      ? { stubCommentId }
      : {}),
    resolutionOutcome: record.resolutionOutcome,
  });
}

export function matchesVerificationThreadCompletion(
  receipt: VerificationThreadCompletion | undefined,
  expected: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly headSha: unknown;
    readonly verdict: unknown;
    readonly requiresStub: unknown;
  },
) {
  if (receipt == null || typeof expected.requiresStub !== "boolean")
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    receipt.workItemId === expected.workItemId &&
      receipt.operationKey === expected.operationKey &&
      receipt.headSha === expected.headSha &&
      receipt.verdict === expected.verdict &&
      receipt.resolutionOutcome ===
        (expected.verdict === "skipped" ? "not_required" : "resolved") &&
      (expected.requiresStub
        ? receipt.stubOutcome === "written" ||
          ((expected.verdict === "fixed" || expected.verdict === "already-resolved") &&
            receipt.stubOutcome === "missing")
        : receipt.stubOutcome === "not_required"),
  );
}

function withParsedFailureSignal(
  threads: Readonly<Record<string, VerificationThreadState>>,
  detail: Record<string, unknown>,
) {
  const failureSignal = parseFailureSignal(detail.failureSignal);
  return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)(
    failureSignal == null ? { threads } : { threads, failureSignal },
  );
}

export function parseVerificationThreadLedger(detail: unknown) {
  if (!isRecord(detail)) {
    return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)({ threads: {} });
  }
  const record = detail;
  if (isRecord(record.threads)) {
    const threads: Record<string, VerificationThreadState> = {};
    for (const [key, value] of Object.entries(record.threads)) {
      const parsed = parseThreadState(value);
      if (parsed) threads[key] = parsed;
    }
    return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)(
      withParsedFailureSignal(threads, record),
    );
  }

  const acted = record.actedThreadIds;
  if (!Array.isArray(acted)) {
    return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)(
      withParsedFailureSignal({}, record),
    );
  }
  const threads: Record<string, VerificationThreadState> = {};
  for (const item of acted) {
    if (!Number.isInteger(item)) continue;
    threads[String(item)] = { lastVerdict: "skipped" };
  }
  return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)(
    withParsedFailureSignal(threads, record),
  );
}

export async function loadVerificationThreadLedger(
  pool: Pool,
  params: {
    readonly resourceKey: string;
  },
) {
  const detail = await createPublishContext(pool, {
    resourceKey: params.resourceKey,
    reviewLens: VERIFICATION_PUBLISH_LENS,
  }).latest(VERIFICATION_THREAD_ACTIONS_STEP);
  return ((pinnedReturn: VerificationThreadLedger | Promise<VerificationThreadLedger>) =>
    pinnedReturn)(parseVerificationThreadLedger(detail));
}

export async function saveVerificationThreadLedger(
  pool: Pool,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly ledger: VerificationThreadLedger;
    readonly leaseEpoch: number | null;
  },
) {
  await createPublishContext(pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: VERIFICATION_PUBLISH_LENS,
    step: VERIFICATION_THREAD_ACTIONS_STEP,
    detail: {
      threads: params.ledger.threads,
      ...(params.ledger.failureSignal != null
        ? { failureSignal: params.ledger.failureSignal }
        : {}),
    },
    leaseEpoch: params.leaseEpoch,
  }).record();
}

export function upsertVerificationThreadState(
  ledger: VerificationThreadLedger,
  rootCommentId: number,
  state: VerificationThreadState,
) {
  return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)({
    ...ledger,
    threads: {
      ...ledger.threads,
      [String(rootCommentId)]: state,
    },
  });
}

export function upsertVerificationFailureSignal(
  ledger: VerificationThreadLedger,
  failureSignal: VerificationFailureSignal,
) {
  return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)({ ...ledger, failureSignal });
}

export function clearVerificationFailureSignalFromLedger(ledger: VerificationThreadLedger) {
  return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)({ threads: ledger.threads });
}
