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

function base32(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  for (let index = 0; index < ID_BODY_CHARS; index += 1) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

export function isFindingId(value: string): value is FindingId {
  return FINDING_ID_RE.test(value);
}

function findingId(prefix: "f" | "l", bytes: Uint8Array): FindingId {
  const value = `${prefix}_${base32(bytes)}`;
  if (!isFindingId(value)) throw new Error("minted finding id is malformed");
  return value;
}

export function mintFindingId(): FindingId {
  return findingId("f", crypto.randomBytes(16));
}

export function derivedFindingId(material: readonly string[]): FindingId {
  return findingId(
    "f",
    crypto.createHash("sha256").update(material.join("\0")).digest().subarray(0, 16),
  );
}

export function legacyFindingId(threadNodeId: string): FindingId {
  return findingId("l", crypto.createHash("sha256").update(threadNodeId).digest().subarray(0, 16));
}

function isFindingSeverity(value: string): value is FindingSeverity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function normalizedLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

export function isBotAuthor(authorLogin: string | null, botLogin: string): boolean {
  return authorLogin != null && normalizedLogin(authorLogin) === normalizedLogin(botLogin);
}

const OBJECTION_ANSWER_MARKER = /<!--\s*pr-agent:objection-answer\b[\s\S]*?-->/gi;

export function renderObjectionAnswerMarker(commentId: number, updatedAt: string): string {
  return `<!-- pr-agent:objection-answer v=1 c=${commentId} u=${updatedAt} -->`;
}

export function withoutObjectionAnswerMarkers(body: string): string {
  return body.replace(OBJECTION_ANSWER_MARKER, "");
}

export function commentCarriesObjectionAnswer(
  body: string,
  commentId: number,
  updatedAt: string,
): boolean {
  return body.includes(renderObjectionAnswerMarker(commentId, updatedAt));
}

export function renderFindingMarker(marker: FindingMarker): string {
  const reopens = marker.reopens == null ? "" : ` reopens=${marker.reopens}`;
  return `<!-- pr-agent:finding v=${MARKER_VERSION} id=${marker.id} lens=${marker.lens} sev=${marker.severity}${reopens} -->`;
}

function parseMarkerFields(
  version: string,
  rawId: string,
  rawLens: string,
  rawSeverity: string,
  rawReopens: string | undefined,
): FindingMarker | null {
  if (version !== MARKER_VERSION) return null;
  if (!isFindingId(rawId) || !isFindingSource(rawLens) || !isFindingSeverity(rawSeverity)) {
    return null;
  }
  if (rawReopens == null) return { id: rawId, lens: rawLens, severity: rawSeverity };
  if (!isFindingId(rawReopens)) return null;
  return { id: rawId, lens: rawLens, severity: rawSeverity, reopens: rawReopens };
}

export function parseOwnedFindingMarker(
  comment: OwnedComment & { readonly isRoot: boolean },
  botLogin: string,
): FindingMarker | null {
  if (!comment.isRoot || !isBotAuthor(comment.authorLogin, botLogin)) return null;
  const matches = [...comment.body.matchAll(FINDING_MARKER_RE)];
  const [match] = matches;
  if (matches.length !== 1 || match == null) return null;
  return parseMarkerFields(match[1], match[2], match[3], match[4], match[5]);
}

export function renderFindingRowMarker(row: FindingRowMarker): string {
  const reopens = row.reopens == null ? "" : ` reopens=${row.reopens}`;
  return `<!-- pr-agent:finding-row v=${MARKER_VERSION} id=${row.id} lens=${row.lens} sev=${row.severity} path=${encodeURIComponent(row.path)} line=${row.line ?? "-"} title=${encodeURIComponent(row.title)}${reopens} -->`;
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseRowLine(value: string): number | null | undefined {
  if (value === "-") return null;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

export function parseOwnedFindingRows(comment: OwnedComment, botLogin: string): FindingRowMarker[] {
  if (!isBotAuthor(comment.authorLogin, botLogin)) return [];
  return [...comment.body.matchAll(FINDING_ROW_RE)].flatMap((match) => {
    const [, version, rawId, rawLens, rawSeverity, rawPath, rawLine, rawTitle, rawReopens] = match;
    const marker = parseMarkerFields(version, rawId, rawLens, rawSeverity, rawReopens);
    const path = decoded(rawPath);
    const title = decoded(rawTitle);
    const line = parseRowLine(rawLine);
    if (marker == null || path == null || path.length === 0 || title == null || line === undefined)
      return [];
    return [{ ...marker, path, line, title }];
  });
}

export function renderReceipt(receipt: FindingReceipt): string {
  const canonical = receipt.kind === "duplicate" ? ` canonical=${receipt.canonical}` : "";
  return `<!-- pr-agent:receipt v=${MARKER_VERSION} kind=${receipt.kind} id=${receipt.id}${canonical} -->`;
}

export function parseOwnedReceipts(
  comments: readonly OwnedComment[],
  botLogin: string,
): FindingReceipt[] {
  return comments.flatMap((comment) => {
    if (!isBotAuthor(comment.authorLogin, botLogin)) return [];
    return [...comment.body.matchAll(RECEIPT_RE)].flatMap((match): FindingReceipt[] => {
      const [, version, kind, rawId, rawCanonical] = match;
      if (version !== MARKER_VERSION || !isFindingId(rawId)) return [];
      if (kind === "duplicate") {
        if (rawCanonical == null || !isFindingId(rawCanonical)) return [];
        return [{ kind, id: rawId, canonical: rawCanonical }];
      }
      if (rawCanonical != null) return [];
      return kind === "fixed" || kind === "dismissed" ? [{ kind, id: rawId }] : [];
    });
  });
}
