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
