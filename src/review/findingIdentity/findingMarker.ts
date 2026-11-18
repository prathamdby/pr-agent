import crypto from "node:crypto";
import { neutralizeMarkerEcho } from "../../prompts/shared/safety.ts";
import { isFindingSource, type FindingSource } from "../orchestrator/orchestratorTypes.ts";
import type { ReviewFinding } from "../reviewSchema.ts";

export { neutralizeMarkerEcho };

export type FindingId = string & { readonly __brand: "FindingId" };
export type FindingSeverity = ReviewFinding["severity"];

export type FindingMarker = {
  readonly id: FindingId;
  readonly lens: FindingSource;
  readonly severity: FindingSeverity;
  readonly reopens?: FindingId;
};

export type FindingRowMarker = FindingMarker & {
  readonly path: string;
  readonly line: number | null;
  readonly title: string;
};

export type FindingReceipt =
  | { readonly kind: "duplicate"; readonly id: FindingId; readonly canonical: FindingId }
  | { readonly kind: "fixed" | "dismissed"; readonly id: FindingId };

type OwnedComment = { readonly body: string; readonly authorLogin: string | null };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_BODY_CHARS = 26;
const FINDING_ID_RE = /^[fl]_[0-9A-HJKMNP-TV-Z]{26}$/;
const MARKER_VERSION = "1";
const FINDING_MARKER_RE =
  /^<!-- pr-agent:finding v=(\S+) id=(\S+) lens=(\S+) sev=(\S+)(?: reopens=(\S+))? -->$/gm;
const FINDING_ROW_RE =
  /<!-- pr-agent:finding-row v=(\S+) id=(\S+) lens=(\S+) sev=(\S+) path=(\S+) line=(\S+) title=(\S+)(?: reopens=(\S+))? -->/g;
const RECEIPT_RE =
  /^<!-- pr-agent:receipt v=(\S+) kind=(duplicate|fixed|dismissed) id=(\S+)(?: canonical=(\S+))? -->$/gm;

function base32(bytes: Uint8Array) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  for (let index = 0; index < ID_BODY_CHARS; index += 1) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return ((pinnedReturn: string) => pinnedReturn)(out);
}

export function isFindingId(value: string): value is FindingId {
  return FINDING_ID_RE.test(value);
}

function findingId(prefix: "f" | "l", bytes: Uint8Array) {
  const value = `${prefix}_${base32(bytes)}`;
  if (!isFindingId(value)) throw new Error("minted finding id is malformed");
  return ((pinnedReturn: FindingId) => pinnedReturn)(value);
}

export function mintFindingId() {
  return ((pinnedReturn: FindingId) => pinnedReturn)(findingId("f", crypto.randomBytes(16)));
}

export function derivedFindingId(material: readonly string[]) {
  return ((pinnedReturn: FindingId) => pinnedReturn)(
    findingId(
      "f",
      crypto.createHash("sha256").update(material.join("\0")).digest().subarray(0, 16),
    ),
  );
}

export function legacyFindingId(threadNodeId: string) {
  return ((pinnedReturn: FindingId) => pinnedReturn)(
    findingId("l", crypto.createHash("sha256").update(threadNodeId).digest().subarray(0, 16)),
  );
}

function isFindingSeverity(value: string): value is FindingSeverity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function normalizedLogin(login: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    login
      .trim()
      .toLowerCase()
      .replace(/\[bot\]$/, ""),
  );
}

export function isBotAuthor(authorLogin: string | null, botLogin: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    authorLogin != null && normalizedLogin(authorLogin) === normalizedLogin(botLogin),
  );
}

const OBJECTION_ANSWER_MARKER = /<!--\s*pr-agent:objection-answer\b[\s\S]*?-->/gi;

export function renderObjectionAnswerMarker(commentId: number, updatedAt: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:objection-answer v=1 c=${commentId} u=${updatedAt} -->`,
  );
}

export function withoutObjectionAnswerMarkers(body: string) {
  return ((pinnedReturn: string) => pinnedReturn)(body.replace(OBJECTION_ANSWER_MARKER, ""));
}

export function commentCarriesObjectionAnswer(body: string, commentId: number, updatedAt: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    body.includes(renderObjectionAnswerMarker(commentId, updatedAt)),
  );
}

export function renderFindingMarker(marker: FindingMarker) {
  const reopens = marker.reopens == null ? "" : ` reopens=${marker.reopens}`;
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:finding v=${MARKER_VERSION} id=${marker.id} lens=${marker.lens} sev=${marker.severity}${reopens} -->`,
  );
}

function parseMarkerFields(
  version: string,
  rawId: string,
  rawLens: string,
  rawSeverity: string,
  rawReopens: string | undefined,
) {
  if (version !== MARKER_VERSION)
    return ((pinnedReturn: FindingMarker | null) => pinnedReturn)(null);
  if (!isFindingId(rawId) || !isFindingSource(rawLens) || !isFindingSeverity(rawSeverity)) {
    return ((pinnedReturn: FindingMarker | null) => pinnedReturn)(null);
  }
  if (rawReopens == null)
    return ((pinnedReturn: FindingMarker | null) => pinnedReturn)({
      id: rawId,
      lens: rawLens,
      severity: rawSeverity,
    });
  if (!isFindingId(rawReopens)) return ((pinnedReturn: FindingMarker | null) => pinnedReturn)(null);
  return ((pinnedReturn: FindingMarker | null) => pinnedReturn)({
    id: rawId,
    lens: rawLens,
    severity: rawSeverity,
    reopens: rawReopens,
  });
}

export function parseOwnedFindingMarker(
  comment: OwnedComment & { readonly isRoot: boolean },
  botLogin: string,
) {
  if (!comment.isRoot || !isBotAuthor(comment.authorLogin, botLogin))
    return ((pinnedReturn: FindingMarker | null) => pinnedReturn)(null);
  const matches = [...comment.body.matchAll(FINDING_MARKER_RE)];
  const [match] = matches;
  if (matches.length !== 1 || match == null)
    return ((pinnedReturn: FindingMarker | null) => pinnedReturn)(null);
  return ((pinnedReturn: FindingMarker | null) => pinnedReturn)(
    parseMarkerFields(match[1], match[2], match[3], match[4], match[5]),
  );
}

export function renderFindingRowMarker(row: FindingRowMarker) {
  const reopens = row.reopens == null ? "" : ` reopens=${row.reopens}`;
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:finding-row v=${MARKER_VERSION} id=${row.id} lens=${row.lens} sev=${row.severity} path=${encodeURIComponent(row.path)} line=${row.line ?? "-"} title=${encodeURIComponent(row.title)}${reopens} -->`,
  );
}

function decoded(value: string) {
  try {
    return ((pinnedReturn: string | null) => pinnedReturn)(decodeURIComponent(value));
  } catch {
    return ((pinnedReturn: string | null) => pinnedReturn)(null);
  }
}

function parseRowLine(value: string) {
  if (value === "-") return ((pinnedReturn: number | null | undefined) => pinnedReturn)(null);
  if (!/^[1-9]\d*$/.test(value))
    return ((pinnedReturn: number | null | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: number | null | undefined) => pinnedReturn)(Number(value));
}

export function parseOwnedFindingRows(comment: OwnedComment, botLogin: string) {
  if (!isBotAuthor(comment.authorLogin, botLogin))
    return ((pinnedReturn: FindingRowMarker[]) => pinnedReturn)([]);
  return ((pinnedReturn: FindingRowMarker[]) => pinnedReturn)(
    [...comment.body.matchAll(FINDING_ROW_RE)].flatMap((match) => {
      const [, version, rawId, rawLens, rawSeverity, rawPath, rawLine, rawTitle, rawReopens] =
        match;
      const marker = parseMarkerFields(version, rawId, rawLens, rawSeverity, rawReopens);
      const path = decoded(rawPath);
      const title = decoded(rawTitle);
      const line = parseRowLine(rawLine);
      if (
        marker == null ||
        path == null ||
        path.length === 0 ||
        title == null ||
        line === undefined
      )
        return [];
      return [{ ...marker, path, line, title }];
    }),
  );
}

export function renderReceipt(receipt: FindingReceipt) {
  const canonical = receipt.kind === "duplicate" ? ` canonical=${receipt.canonical}` : "";
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:receipt v=${MARKER_VERSION} kind=${receipt.kind} id=${receipt.id}${canonical} -->`,
  );
}

export function parseOwnedReceipts(comments: readonly OwnedComment[], botLogin: string) {
  return ((pinnedReturn: FindingReceipt[]) => pinnedReturn)(
    comments.flatMap((comment) => {
      if (!isBotAuthor(comment.authorLogin, botLogin)) return [];
      return [...comment.body.matchAll(RECEIPT_RE)].flatMap((match) => {
        const [, version, kind, rawId, rawCanonical] = match;
        if (version !== MARKER_VERSION || !isFindingId(rawId))
          return ((pinnedReturn: FindingReceipt[]) => pinnedReturn)([]);
        if (kind === "duplicate") {
          if (rawCanonical == null || !isFindingId(rawCanonical))
            return ((pinnedReturn: FindingReceipt[]) => pinnedReturn)([]);
          return ((pinnedReturn: FindingReceipt[]) => pinnedReturn)([
            { kind, id: rawId, canonical: rawCanonical },
          ]);
        }
        if (rawCanonical != null) return ((pinnedReturn: FindingReceipt[]) => pinnedReturn)([]);
        return ((pinnedReturn: FindingReceipt[]) => pinnedReturn)(
          kind === "fixed" || kind === "dismissed" ? [{ kind, id: rawId }] : [],
        );
      });
    }),
  );
}
