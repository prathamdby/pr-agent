import {
  CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH,
  CODE_MODE_SERIALIZE_MAX_DEPTH,
  CODE_MODE_SERIALIZE_MAX_STRING_BYTES,
} from "../../settings/index.js";

export type SerializedTruncation = {
  readonly truncated: true;
  readonly omittedCount?: number;
  readonly reason: string;
};

export type SerializeCodeModeValueOptions = {
  readonly maxDepth?: number;
  readonly maxArrayLength?: number;
  readonly maxStringBytes?: number;
};

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return { text: value, truncated: false };
  const buf = Buffer.from(value, "utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

function serializeInner(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  options: Required<SerializeCodeModeValueOptions>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (typeof value === "string") {
    const capped = truncateUtf8(value, options.maxStringBytes);
    if (!capped.truncated) return value;
    return {
      truncated: true,
      omittedCount: Buffer.byteLength(value, "utf8") - Buffer.byteLength(capped.text, "utf8"),
      reason: "string_byte_limit",
      value: capped.text,
    };
  }
  if (depth >= options.maxDepth) {
    return { truncated: true, reason: "max_depth" } satisfies SerializedTruncation;
  }
  if (seen.has(value)) {
    return { truncated: true, reason: "cycle" } satisfies SerializedTruncation;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const omittedCount = Math.max(0, value.length - options.maxArrayLength);
    const items = value
      .slice(0, options.maxArrayLength)
      .map((entry) => serializeInner(entry, depth + 1, seen, options));
    if (omittedCount === 0) return items;
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
    out[key] = serializeInner(entry, depth + 1, seen, options);
  }
  return out;
}

export function serializeCodeModeValue(
  value: unknown,
  options?: SerializeCodeModeValueOptions,
): unknown {
  return serializeInner(value, 0, new WeakSet(), {
    maxDepth: options?.maxDepth ?? CODE_MODE_SERIALIZE_MAX_DEPTH,
    maxArrayLength: options?.maxArrayLength ?? CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH,
    maxStringBytes: options?.maxStringBytes ?? CODE_MODE_SERIALIZE_MAX_STRING_BYTES,
  });
}
