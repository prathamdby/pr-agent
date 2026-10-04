import { createPublishContext } from "./publishOnce.js";
import type { Pool } from "pg";
import type { VerificationFailureSurface } from "../review/ci/ciSummaryCell.js";
import { VERIFICATION_PUBLISH_LENS } from "../settings/index.js";
import { isRecord } from "../util/typeGuards.js";

type VerificationThreadVerdict = "skipped" | "dismissed" | "fixed" | "already-resolved";

export type { VerificationFailureSurface };

export type VerificationFailureSignal = {
  readonly headSha: string;
  readonly commentId: number;
  readonly surface: VerificationFailureSurface;
};

export type VerificationThreadState = {
  readonly stubCommentId?: number;
  readonly lastVerdict: VerificationThreadVerdict;
  readonly lastHeadSha?: string;
  readonly terminal?: boolean;
  readonly completion?: VerificationThreadCompletion;
};

/** Resource-scoped history is not completion evidence without this exact attempt receipt. */
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

function parseFailureSurface(value: unknown): VerificationFailureSurface | null {
  switch (value) {
    case "ci_cell":
    case "stub_line":
      return value;
    default:
      return null;
  }
}

function parseFailureSignal(value: unknown): VerificationFailureSignal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const surface = parseFailureSurface(record.surface);
  if (surface == null) return undefined;
  if (typeof record.headSha !== "string" || record.headSha.length === 0) return undefined;
  if (typeof record.commentId !== "number" || !Number.isInteger(record.commentId)) return undefined;
  return {
    headSha: record.headSha,
    commentId: record.commentId,
    surface,
  };
}

function parseThreadState(value: unknown): VerificationThreadState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isVerdict(record.lastVerdict)) return null;
  const stubCommentId = record.stubCommentId;
  const lastHeadSha = record.lastHeadSha;
  const terminal = record.terminal;
  const completion = parseVerificationThreadCompletion(record.completion);
  return {
    lastVerdict: record.lastVerdict,
    ...(typeof stubCommentId === "number" && Number.isInteger(stubCommentId)
      ? { stubCommentId }
      : {}),
    ...(typeof lastHeadSha === "string" ? { lastHeadSha } : {}),
    ...(terminal === true ? { terminal: true } : {}),
    ...(completion != null ? { completion } : {}),
  };
}

function parseVerificationThreadCompletion(value: unknown): VerificationThreadCompletion | null {
  if (!isRecord(value)) return null;
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
    return null;
  const stubCommentId = record.stubCommentId;
  if (
    record.stubOutcome === "written" &&
    (typeof stubCommentId !== "number" ||
      !Number.isSafeInteger(stubCommentId) ||
      stubCommentId <= 0)
  )
    return null;
  return {
    workItemId: record.workItemId,
    operationKey: record.operationKey,
    headSha: record.headSha,
    verdict: record.verdict,
    stubOutcome: record.stubOutcome,
    ...(record.stubOutcome === "written" && typeof stubCommentId === "number"
      ? { stubCommentId }
      : {}),
    resolutionOutcome: record.resolutionOutcome,
  };
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
): boolean {
  if (receipt == null || typeof expected.requiresStub !== "boolean") return false;
  return (
    receipt.workItemId === expected.workItemId &&
    receipt.operationKey === expected.operationKey &&
    receipt.headSha === expected.headSha &&
    receipt.verdict === expected.verdict &&
    receipt.resolutionOutcome === (expected.verdict === "skipped" ? "not_required" : "resolved") &&
    (expected.requiresStub
      ? receipt.stubOutcome === "written" ||
        ((expected.verdict === "fixed" || expected.verdict === "already-resolved") &&
          receipt.stubOutcome === "missing")
      : receipt.stubOutcome === "not_required")
  );
}

function withParsedFailureSignal(
  threads: Readonly<Record<string, VerificationThreadState>>,
  detail: Record<string, unknown>,
): VerificationThreadLedger {
  const failureSignal = parseFailureSignal(detail.failureSignal);
  return failureSignal == null ? { threads } : { threads, failureSignal };
}

export function parseVerificationThreadLedger(detail: unknown): VerificationThreadLedger {
  if (!detail || typeof detail !== "object") {
    return { threads: {} };
  }
  const record = detail as Record<string, unknown>;
  if (record.threads && typeof record.threads === "object" && !Array.isArray(record.threads)) {
    const threads: Record<string, VerificationThreadState> = {};
    for (const [key, value] of Object.entries(record.threads as Record<string, unknown>)) {
      const parsed = parseThreadState(value);
      if (parsed) threads[key] = parsed;
    }
    return withParsedFailureSignal(threads, record);
  }

  // Legacy shape from per-work-item actedThreadIds checkpoints.
  const acted = record.actedThreadIds;
  if (!Array.isArray(acted)) {
    return withParsedFailureSignal({}, record);
  }
  const threads: Record<string, VerificationThreadState> = {};
  for (const item of acted) {
    if (!Number.isInteger(item)) continue;
    threads[String(item)] = { lastVerdict: "skipped" };
  }
  return withParsedFailureSignal(threads, record);
}

export async function loadVerificationThreadLedger(
  pool: Pool,
  params: {
    readonly resourceKey: string;
  },
): Promise<VerificationThreadLedger> {
  const detail = await createPublishContext(pool, {
    resourceKey: params.resourceKey,
    reviewLens: VERIFICATION_PUBLISH_LENS,
  }).latest(VERIFICATION_THREAD_ACTIONS_STEP);
  return parseVerificationThreadLedger(detail);
}

export async function saveVerificationThreadLedger(
  pool: Pool,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly ledger: VerificationThreadLedger;
    readonly leaseEpoch: number | null;
  },
): Promise<void> {
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
): VerificationThreadLedger {
  return {
    ...ledger,
    threads: {
      ...ledger.threads,
      [String(rootCommentId)]: state,
    },
  };
}

export function upsertVerificationFailureSignal(
  ledger: VerificationThreadLedger,
  failureSignal: VerificationFailureSignal,
): VerificationThreadLedger {
  return { ...ledger, failureSignal };
}

export function clearVerificationFailureSignalFromLedger(
  ledger: VerificationThreadLedger,
): VerificationThreadLedger {
  return { threads: ledger.threads };
}
