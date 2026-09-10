import { createHash } from "node:crypto";

export type EvidenceRead = {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly contentHash: string;
  readonly headSha: string;
  readonly tool: string;
  readonly recordedAt: string;
};

export function normalizeEvidencePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function hashNormalizedLineText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function segmentsExcluding(
  startLine: number,
  endLine: number,
  excluded?: readonly number[],
): [number, number][] {
  if (!excluded || excluded.length === 0) return [[startLine, endLine]];
  const sorted = [...new Set(excluded)]
    .filter((line) => line >= startLine && line <= endLine)
    .sort((a, b) => a - b);
  const segments: [number, number][] = [];
  let cur = startLine;
  for (const line of sorted) {
    if (line > cur) segments.push([cur, line - 1]);
    cur = line + 1;
  }
  if (cur <= endLine) segments.push([cur, endLine]);
  return segments;
}

export function recordDeliveredFileRead(
  ledger: EvidenceLedger,
  params: {
    readonly path: string;
    readonly headSha: string;
    readonly tool: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
    readonly clampedLines?: readonly number[];
  },
): void {
  if (params.content.length === 0 || params.startLine <= 0 || params.endLine <= 0) return;
  for (const [startLine, endLine] of segmentsExcluding(
    params.startLine,
    params.endLine,
    params.clampedLines,
  )) {
    ledger.record({
      path: params.path,
      startLine,
      endLine,
      contentHash: hashNormalizedLineText(params.content),
      headSha: params.headSha,
      tool: params.tool,
    });
  }
}

function lineRangeCovers(
  evidenceStart: number,
  evidenceEnd: number,
  findingStart: number,
  findingEnd: number,
): boolean {
  return evidenceStart <= findingStart && evidenceEnd >= findingEnd;
}

export type EvidenceLedger = {
  readonly headSha: string;
  record: (read: Omit<EvidenceRead, "recordedAt">) => void;
  covers: (path: string, startLine: number, endLine: number) => boolean;
  snapshot: () => readonly EvidenceRead[];
};

export function createEvidenceLedger(headSha: string): EvidenceLedger {
  const reads: EvidenceRead[] = [];

  return {
    headSha,
    record(read) {
      reads.push({
        ...read,
        path: normalizeEvidencePath(read.path),
        recordedAt: new Date().toISOString(),
      });
    },
    covers(path, startLine, endLine) {
      const normalized = normalizeEvidencePath(path);
      return reads.some((read) => {
        if (read.headSha !== headSha) return false;
        if (read.path !== normalized) return false;
        const evidenceStart = read.startLine ?? 1;
        const evidenceEnd = read.endLine ?? evidenceStart;
        return lineRangeCovers(evidenceStart, evidenceEnd, startLine, endLine);
      });
    },
    snapshot() {
      return [...reads];
    },
  };
}
