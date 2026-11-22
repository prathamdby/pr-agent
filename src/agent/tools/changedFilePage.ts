import {
  CODE_MODE_HOST_TO_GUEST_MAX_BYTES,
  CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH,
  CODE_MODE_SERIALIZE_MAX_STRING_BYTES,
} from "../../settings/index.ts";
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

function encodeContinuation(head: string, offset: number) {
  const json = JSON.stringify({ v: 1, head: head.toLowerCase(), offset });
  return ((pinnedReturn: string) => pinnedReturn)(
    `cf1.${Buffer.from(json, "utf8").toString("base64url")}`,
  );
}

function decodeContinuation(token: string) {
  if (!token.startsWith("cf1.")) return ((pinnedReturn: PageToken | null) => pinnedReturn)(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token.slice("cf1.".length), "base64url").toString("utf8"));
  } catch {
    return ((pinnedReturn: PageToken | null) => pinnedReturn)(null);
  }
  if (!isRecord(parsed)) return ((pinnedReturn: PageToken | null) => pinnedReturn)(null);
  const keys = Object.keys(parsed);
  if (keys.length !== 3 || parsed.v !== 1)
    return ((pinnedReturn: PageToken | null) => pinnedReturn)(null);
  if (!keys.every((key) => key === "v" || key === "head" || key === "offset"))
    return ((pinnedReturn: PageToken | null) => pinnedReturn)(null);
  if (typeof parsed.head !== "string" || parsed.head.length === 0)
    return ((pinnedReturn: PageToken | null) => pinnedReturn)(null);
  if (typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
    return ((pinnedReturn: PageToken | null) => pinnedReturn)(null);
  }
  return ((pinnedReturn: PageToken | null) => pinnedReturn)({
    head: parsed.head,
    offset: parsed.offset,
  });
}

function pageFits(page: ChangedFilePage) {
  if (page.files.length > CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  for (const file of page.files) {
    if (
      Buffer.byteLength(file.path, "utf8") > CODE_MODE_SERIALIZE_MAX_STRING_BYTES ||
      (file.oldPath !== undefined &&
        Buffer.byteLength(file.oldPath, "utf8") > CODE_MODE_SERIALIZE_MAX_STRING_BYTES)
    )
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(
    Buffer.byteLength(JSON.stringify(page), "utf8") <= CODE_MODE_HOST_TO_GUEST_MAX_BYTES,
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
) {
  const next =
    start + count < input.files.length ? encodeContinuation(input.headSha, start + count) : null;
  return ((pinnedReturn: ChangedFilePage) => pinnedReturn)({
    files: input.files.slice(start, start + count),
    total: input.files.length,
    truncated: input.truncated,
    headSha: input.headSha,
    continuation: next,
    ...(input.warning !== undefined ? { warning: input.warning } : {}),
  });
}

export function pageChangedFiles(input: {
  readonly files: readonly ChangedFileRecord[];
  readonly headSha: string;
  readonly truncated: boolean;
  readonly warning?: string;
  readonly continuation?: string;
}) {
  let start = 0;
  if (input.continuation !== undefined) {
    const token = decodeContinuation(input.continuation);
    if (!token)
      return ((pinnedReturn: ChangedFilePageResult) => pinnedReturn)({
        ok: false,
        reason: "malformed",
      });
    if (token.head !== input.headSha.toLowerCase())
      return ((pinnedReturn: ChangedFilePageResult) => pinnedReturn)({
        ok: false,
        reason: "head_mismatch",
      });
    if (
      token.offset > input.files.length ||
      (token.offset === input.files.length && token.offset > 0)
    ) {
      return ((pinnedReturn: ChangedFilePageResult) => pinnedReturn)({
        ok: false,
        reason: "offset",
      });
    }
    start = token.offset;
  }

  if (start === input.files.length) {
    return ((pinnedReturn: ChangedFilePageResult) => pinnedReturn)({
      ok: true,
      page: payloadFor(input, start, 0),
    });
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
  if (!fitted)
    return ((pinnedReturn: ChangedFilePageResult) => pinnedReturn)({
      ok: false,
      reason: "undeliverable",
    });
  return ((pinnedReturn: ChangedFilePageResult) => pinnedReturn)({ ok: true, page: fitted });
}
