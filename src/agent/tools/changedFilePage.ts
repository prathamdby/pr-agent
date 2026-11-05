import { boundJsonValue } from "../execution/marshal.ts";
import { CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH } from "../../settings/index.ts";
import { isRecord } from "../../util/typeGuards.ts";

export type ChangedFileRecord = {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: string;
  readonly presentInCheckout: boolean;
};

export type ChangedFilePage = {
  readonly files: readonly ChangedFileRecord[];
  readonly total: number;
  readonly truncated: boolean;
  readonly headSha: string;
  readonly continuation: string | null;
  readonly warning?: string;
};

export type ChangedFilePageFailure = "malformed" | "head_mismatch" | "offset" | "undeliverable";

export type ChangedFilePageResult =
  | { readonly ok: true; readonly page: ChangedFilePage }
  | { readonly ok: false; readonly reason: ChangedFilePageFailure };

type PageToken = {
  readonly head: string;
  readonly offset: number;
};

function encodeContinuation(head: string, offset: number): string {
  const json = JSON.stringify({ v: 1, head: head.toLowerCase(), offset });
  return `cf1.${Buffer.from(json, "utf8").toString("base64url")}`;
}

function decodeContinuation(token: string): PageToken | null {
  if (!token.startsWith("cf1.")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token.slice("cf1.".length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 3 || parsed.v !== 1) return null;
  if (!keys.every((key) => key === "v" || key === "head" || key === "offset")) return null;
  if (typeof parsed.head !== "string" || parsed.head.length === 0) return null;
  if (typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
    return null;
  }
  return { head: parsed.head, offset: parsed.offset };
}

function sameEntry(left: ChangedFileRecord, right: unknown): boolean {
  if (!isRecord(right)) return false;
  if (right.path !== left.path || right.status !== left.status) return false;
  if (right.presentInCheckout !== left.presentInCheckout) return false;
  return right.oldPath === left.oldPath;
}

function pageFits(page: ChangedFilePage): boolean {
  const bounded = boundJsonValue(page);
  if (
    bounded.truncation !== null ||
    !isRecord(bounded.value) ||
    !Array.isArray(bounded.value.files)
  ) {
    return false;
  }
  const files = bounded.value.files;
  return (
    files.length === page.files.length &&
    page.files.every((file, index) => sameEntry(file, files[index]))
  );
}

function payloadFor(
  input: {
    readonly files: readonly ChangedFileRecord[];
    readonly headSha: string;
    readonly truncated: boolean;
    readonly warning?: string;
  },
  start: number,
  count: number,
): ChangedFilePage {
  const next =
    start + count < input.files.length ? encodeContinuation(input.headSha, start + count) : null;
  return {
    files: input.files.slice(start, start + count),
    total: input.files.length,
    truncated: input.truncated,
    headSha: input.headSha,
    continuation: next,
    ...(input.warning !== undefined ? { warning: input.warning } : {}),
  };
}

export function pageChangedFiles(input: {
  readonly files: readonly ChangedFileRecord[];
  readonly headSha: string;
  readonly truncated: boolean;
  readonly warning?: string;
  readonly continuation?: string;
}): ChangedFilePageResult {
  let start = 0;
  if (input.continuation !== undefined) {
    const token = decodeContinuation(input.continuation);
    if (!token) return { ok: false, reason: "malformed" };
    if (token.head !== input.headSha.toLowerCase()) return { ok: false, reason: "head_mismatch" };
    if (
      token.offset > input.files.length ||
      (token.offset === input.files.length && token.offset > 0)
    ) {
      return { ok: false, reason: "offset" };
    }
    start = token.offset;
  }

  if (start === input.files.length) {
    return { ok: true, page: payloadFor(input, start, 0) };
  }

  const limit = Math.min(CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH, input.files.length - start);
  let low = 1;
  let high = limit;
  let fitted: ChangedFilePage | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = payloadFor(input, start, mid);
    if (pageFits(candidate)) {
      fitted = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!fitted) return { ok: false, reason: "undeliverable" };
  return { ok: true, page: fitted };
}
