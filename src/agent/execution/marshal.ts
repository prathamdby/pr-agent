import {
  CODE_MODE_HOST_TO_GUEST_MAX_BYTES,
  CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH,
  CODE_MODE_SERIALIZE_MAX_DEPTH,
  CODE_MODE_SERIALIZE_MAX_STRING_BYTES,
} from "../../settings/index.js";
import {
  hashNormalizedLineText,
  recordDeliveredFileRead,
  type EvidenceLedger,
} from "../../review/findings/evidenceLedger.js";
import { parseCommentableRightLineRanges } from "../../review/placement/reviewDiffIndex.js";
import { utf8ByteLength } from "./json.js";

export type TruncationInfo = {
  readonly truncated: true;
  readonly reason: string;
  readonly omittedCount?: number;
  readonly omittedBytes?: number;
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

function truncateUtf8(value: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return { text: value, omittedBytes: 0 };
  const buf = Buffer.from(value, "utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  const text = buf.subarray(0, end).toString("utf8");
  return { text, omittedBytes: bytes - Buffer.byteLength(text, "utf8") };
}

function boundInner(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  options: Required<MarshalOptions>,
  truncation: { current: TruncationInfo | null },
): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (typeof value === "string") {
    const capped = truncateUtf8(value, options.maxStringBytes);
    if (capped.omittedBytes > 0) {
      truncation.current = {
        truncated: true,
        reason: "string_byte_limit",
        omittedBytes: (truncation.current?.omittedBytes ?? 0) + capped.omittedBytes,
      };
    }
    return capped.text;
  }
  if (depth >= options.maxDepth) {
    truncation.current = { truncated: true, reason: "max_depth" };
    return { truncated: true, reason: "max_depth" };
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      truncation.current = { truncated: true, reason: "cycle" };
      return { truncated: true, reason: "cycle" };
    }
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const omittedCount = Math.max(0, value.length - options.maxArrayLength);
    const items = value
      .slice(0, options.maxArrayLength)
      .map((entry) => boundInner(entry, depth + 1, seen, options, truncation));
    if (omittedCount === 0) return items;
    truncation.current = {
      truncated: true,
      reason: "array_length_limit",
      omittedCount: (truncation.current?.omittedCount ?? 0) + omittedCount,
    };
    return {
      truncated: true,
      omittedCount,
      reason: "array_length_limit",
      value: items,
    };
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = boundInner(entry, depth + 1, seen, options, truncation);
  }
  return out;
}

export function boundJsonValue(value: unknown, options?: MarshalOptions): BoundedValue {
  const resolved: Required<MarshalOptions> = {
    maxDepth: options?.maxDepth ?? CODE_MODE_SERIALIZE_MAX_DEPTH,
    maxArrayLength: options?.maxArrayLength ?? CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH,
    maxStringBytes: options?.maxStringBytes ?? CODE_MODE_SERIALIZE_MAX_STRING_BYTES,
    maxTransferBytes: options?.maxTransferBytes ?? CODE_MODE_HOST_TO_GUEST_MAX_BYTES,
  };
  const truncation = { current: null as TruncationInfo | null };
  const bounded = boundInner(value, 0, new WeakSet(), resolved, truncation);
  if (utf8ByteLength(bounded) > resolved.maxTransferBytes) {
    return {
      value: {
        truncated: true,
        reason: "transfer_byte_limit",
      },
      truncation: { truncated: true, reason: "transfer_byte_limit" },
    };
  }
  return { value: bounded, truncation: truncation.current };
}

export function serializeCodeModeValue(
  value: unknown,
  options?: Pick<MarshalOptions, "maxDepth" | "maxArrayLength" | "maxStringBytes">,
): unknown {
  return boundJsonValue(value, options).value;
}

export type CapabilityGuestResult = Record<string, unknown> | { value: unknown };

export function toGuestCapabilityResult(
  bounded: unknown,
  truncation: TruncationInfo | null,
  coverage?: unknown,
): CapabilityGuestResult {
  if (bounded !== null && typeof bounded === "object" && !Array.isArray(bounded)) {
    return {
      ...(bounded as Record<string, unknown>),
      ...(coverage !== undefined ? { coverage } : {}),
      truncation,
    };
  }
  return {
    value: bounded,
    ...(coverage !== undefined ? { coverage } : {}),
    truncation,
  };
}

export function recordMarshalledEvidence(
  delivered: unknown,
  params: {
    readonly tool: string;
    readonly ledger?: EvidenceLedger;
    readonly headSha?: string;
  },
): void {
  if (!params.ledger || !params.headSha) return;
  if (!delivered || typeof delivered !== "object") return;
  const row = delivered as Record<string, unknown>;
  if (typeof row.path === "string" && typeof row.content === "string") {
    const startLine = typeof row.startLine === "number" ? row.startLine : 1;
    const lineCount = row.content.length === 0 ? 0 : row.content.split("\n").length;
    const computedEnd = startLine + Math.max(lineCount, 1) - 1;
    const endLine =
      typeof row.endLine === "number" ? Math.min(row.endLine, computedEnd) : computedEnd;
    const clampedLines = Array.isArray(row.clampedLines)
      ? row.clampedLines.filter((line): line is number => typeof line === "number")
      : undefined;
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
