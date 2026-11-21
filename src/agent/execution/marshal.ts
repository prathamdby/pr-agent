import {
  CODE_MODE_HOST_TO_GUEST_MAX_BYTES,
  CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH,
  CODE_MODE_SERIALIZE_MAX_DEPTH,
  CODE_MODE_SERIALIZE_MAX_STRING_BYTES,
} from "../../settings/index.ts";
import {
  hashNormalizedLineText,
  recordDeliveredFileRead,
  type EvidenceLedger,
} from "../../review/findings/evidenceLedger.ts";
import { parseCommentableRightLineRanges } from "../../prWorkspace/reviewDiffIndex.ts";
import { utf8ByteLength } from "./json.ts";
import { isRecord } from "../../util/typeGuards.ts";

export type TruncationInfo = {
  readonly truncated: true;
  readonly reason: string;
  readonly omittedCount?: number;
  readonly omittedBytes?: number;
  readonly fileContentTruncated?: boolean;
};

export type MarshalOptions = {
  readonly maxDepth?: number;
  readonly maxArrayLength?: number;
  readonly maxStringBytes?: number;
  readonly maxTransferBytes?: number;
};

export type BoundedValue = {
  readonly value: unknown;
  readonly truncation: TruncationInfo | null;
};

function truncateUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes)
    return ((pinnedReturn: { text: string; omittedBytes: number }) => pinnedReturn)({
      text: value,
      omittedBytes: 0,
    });
  const buf = Buffer.from(value, "utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  const text = buf.subarray(0, end).toString("utf8");
  return ((pinnedReturn: { text: string; omittedBytes: number }) => pinnedReturn)({
    text,
    omittedBytes: bytes - Buffer.byteLength(text, "utf8"),
  });
}

const boundInner: (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  options: Required<MarshalOptions>,
  truncation: { current: TruncationInfo | null },
) => unknown = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  options: Required<MarshalOptions>,
  truncation: { current: TruncationInfo | null },
) => {
  if (value === null || value === undefined)
    return ((pinnedReturn: unknown) => pinnedReturn)(value ?? null);
  if (typeof value === "number" || typeof value === "boolean")
    return ((pinnedReturn: unknown) => pinnedReturn)(value);
  if (typeof value === "bigint") return ((pinnedReturn: unknown) => pinnedReturn)(value.toString());
  if (typeof value === "symbol" || typeof value === "function")
    return ((pinnedReturn: unknown) => pinnedReturn)(String(value));
  if (typeof value === "string") {
    const capped = truncateUtf8(value, options.maxStringBytes);
    if (capped.omittedBytes > 0) {
      truncation.current = {
        truncated: true,
        reason: "string_byte_limit",
        omittedBytes: (truncation.current?.omittedBytes ?? 0) + capped.omittedBytes,
      };
    }
    return ((pinnedReturn: unknown) => pinnedReturn)(capped.text);
  }
  if (depth >= options.maxDepth) {
    truncation.current = { truncated: true, reason: "max_depth" };
    return ((pinnedReturn: unknown) => pinnedReturn)({ truncated: true, reason: "max_depth" });
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      truncation.current = { truncated: true, reason: "cycle" };
      return ((pinnedReturn: unknown) => pinnedReturn)({ truncated: true, reason: "cycle" });
    }
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const omittedCount = Math.max(0, value.length - options.maxArrayLength);
    const items = value
      .slice(0, options.maxArrayLength)
      .map((entry) => boundInner(entry, depth + 1, seen, options, truncation));
    if (omittedCount === 0) return ((pinnedReturn: unknown) => pinnedReturn)(items);
    truncation.current = {
      truncated: true,
      reason: "array_length_limit",
      omittedCount: (truncation.current?.omittedCount ?? 0) + omittedCount,
    };
    return ((pinnedReturn: unknown) => pinnedReturn)({
      truncated: true,
      omittedCount,
      reason: "array_length_limit",
      value: items,
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = boundInner(entry, depth + 1, seen, options, truncation);
  }
  return ((pinnedReturn: unknown) => pinnedReturn)(out);
};

function fileContent(value: unknown) {
  if (value === null || typeof value !== "object" || !("content" in value)) return undefined;
  return typeof value.content === "string" ? value.content : undefined;
}

export function boundJsonValue(value: unknown, options?: MarshalOptions) {
  const resolved: Required<MarshalOptions> = {
    maxDepth: options?.maxDepth ?? CODE_MODE_SERIALIZE_MAX_DEPTH,
    maxArrayLength: options?.maxArrayLength ?? CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH,
    maxStringBytes: options?.maxStringBytes ?? CODE_MODE_SERIALIZE_MAX_STRING_BYTES,
    maxTransferBytes: options?.maxTransferBytes ?? CODE_MODE_HOST_TO_GUEST_MAX_BYTES,
  };
  const truncation = { current: null as TruncationInfo | null };
  const bounded = boundInner(value, 0, new WeakSet(), resolved, truncation);
  if (utf8ByteLength(bounded) > resolved.maxTransferBytes) {
    return ((pinnedReturn: BoundedValue) => pinnedReturn)({
      value: {
        truncated: true,
        reason: "transfer_byte_limit",
      },
      truncation: { truncated: true, reason: "transfer_byte_limit" },
    });
  }
  const originalContent = fileContent(value);
  const boundedContent = originalContent != null ? fileContent(bounded) : undefined;
  const fileContentTruncated =
    originalContent != null &&
    boundedContent != null &&
    boundedContent.length < originalContent.length;
  return ((pinnedReturn: BoundedValue) => pinnedReturn)({
    value: bounded,
    truncation:
      truncation.current === null
        ? null
        : {
            ...truncation.current,
            ...(fileContentTruncated ? { fileContentTruncated: true } : {}),
          },
  });
}

export type CapabilityGuestResult = Record<string, unknown> | { value: unknown };

export function toGuestCapabilityResult(
  bounded: unknown,
  truncation: TruncationInfo | null,
  coverage?: unknown,
) {
  if (isRecord(bounded)) {
    return ((pinnedReturn: CapabilityGuestResult) => pinnedReturn)({
      ...bounded,
      ...(coverage !== undefined ? { coverage } : {}),
      truncation,
    });
  }
  return ((pinnedReturn: CapabilityGuestResult) => pinnedReturn)({
    value: bounded,
    ...(coverage !== undefined ? { coverage } : {}),
    truncation,
  });
}

export function recordMarshalledEvidence(
  delivered: unknown,
  params: {
    readonly tool: string;
    readonly ledger?: EvidenceLedger;
    readonly headSha?: string;
  },
) {
  if (!params.ledger || !params.headSha) return;
  if (!isRecord(delivered)) return;
  const row = delivered;
  if (typeof row.path === "string" && typeof row.content === "string") {
    params.ledger.noteOpened(row.path);
    if (row.content.length === 0) return;
    if (row.clampedLines != null && !Array.isArray(row.clampedLines)) return;
    const startLine = typeof row.startLine === "number" ? row.startLine : 1;
    const lineCount = row.content.split("\n").length;
    const computedEnd = startLine + Math.max(lineCount, 1) - 1;
    const endLine =
      typeof row.endLine === "number" ? Math.min(row.endLine, computedEnd) : computedEnd;
    const clampedLines = Array.isArray(row.clampedLines)
      ? row.clampedLines.filter((line): line is number => typeof line === "number")
      : [];
    if (
      row.truncation &&
      typeof row.truncation === "object" &&
      "fileContentTruncated" in row.truncation &&
      row.truncation.fileContentTruncated === true
    ) {
      clampedLines.push(computedEnd);
    }
    recordDeliveredFileRead(params.ledger, {
      path: row.path,
      headSha: params.headSha,
      tool: params.tool,
      startLine,
      endLine,
      content: row.content,
      clampedLines,
    });
    return;
  }
  if (typeof row.path === "string" && typeof row.diff === "string" && row.diff.length > 0) {
    params.ledger.noteOpened(row.path);
    const contentHash = hashNormalizedLineText(row.diff);
    for (const [startLine, endLine] of parseCommentableRightLineRanges(row.diff)) {
      params.ledger.record({
        path: row.path,
        startLine,
        endLine,
        contentHash,
        headSha: params.headSha,
        tool: params.tool,
      });
    }
  }
}
