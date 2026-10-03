import { createHash } from "node:crypto";
import * as v from "valibot";

/** Hash of exactly these complete lines, normalized to LF with no terminal newline. */
export const evidenceDescriptorSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    kind: v.literal("file_range"),
    path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    startLine: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    endLine: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    headSha: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    contentHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  }),
  v.check((read) => read.endLine >= read.startLine),
  v.check((read) => read.path === normalizeEvidencePath(read.path)),
);

export type EvidenceDescriptor = v.InferOutput<typeof evidenceDescriptorSchema>;

export type DeliveredFileRead = {
  readonly path: string;
  readonly headSha: string;
  readonly tool: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly clampedLines?: readonly number[];
};

export type EvidenceRead = {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly contentHash: string;
  readonly headSha: string;
  readonly tool: string;
  readonly recordedAt: string;
  /** Legacy contentHash hashes the whole delivered response, not this coverage segment. */
  readonly descriptor?: EvidenceDescriptor;
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
    .toSorted((a, b) => a - b);
  const segments: [number, number][] = [];
  let cur = startLine;
  for (const line of sorted) {
    if (line > cur) segments.push([cur, line - 1]);
    cur = line + 1;
  }
  if (cur <= endLine) segments.push([cur, endLine]);
  return segments;
}

export function recordDeliveredFileRead(ledger: EvidenceLedger, params: DeliveredFileRead): void {
  if (params.content.length === 0 || params.startLine <= 0 || params.endLine <= 0) return;
  const lines = params.content.replace(/\r\n/g, "\n").split("\n");
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
      // Keep ordinary covers semantics. Only fully reproducible segments are cacheable.
      ...(endLine - params.startLine < lines.length
        ? {
            descriptor: {
              version: 1 as const,
              kind: "file_range" as const,
              path: normalizeEvidencePath(params.path),
              startLine,
              endLine,
              contentHash: hashNormalizedLineText(
                lines
                  .slice(startLine - params.startLine, endLine - params.startLine + 1)
                  .join("\n"),
              ),
              headSha: params.headSha,
            },
          }
        : {}),
    });
  }
}

/**
 * The callback must use the current governed workspace reader, never raw filesystem
 * I/O or saved text. Refusal/mismatch is a cache miss; reader errors still propagate.
 * No coverage is granted until every descriptor matches a fresh read.
 */
export async function revalidateEvidenceDescriptors(
  ledger: EvidenceLedger,
  descriptors: readonly unknown[],
  read: (descriptor: EvidenceDescriptor) => Promise<DeliveredFileRead | null>,
): Promise<boolean> {
  const parsed = v.safeParse(v.array(evidenceDescriptorSchema), descriptors);
  if (!parsed.success || parsed.output.some((entry) => entry.headSha !== ledger.headSha))
    return false;
  const staged = createEvidenceLedger(ledger.headSha);
  for (const descriptor of parsed.output) {
    const fresh = await read(descriptor);
    if (
      !fresh ||
      fresh.headSha !== descriptor.headSha ||
      normalizeEvidencePath(fresh.path) !== descriptor.path ||
      fresh.startLine !== descriptor.startLine ||
      fresh.endLine !== descriptor.endLine ||
      fresh.content.length === 0 ||
      (fresh.clampedLines?.some((line) => line >= fresh.startLine && line <= fresh.endLine) ??
        false)
    )
      return false;
    const lines = fresh.content.replace(/\r\n/g, "\n").split("\n");
    const count = descriptor.endLine - descriptor.startLine + 1;
    if (
      lines.length < count ||
      (lines.length > count && !(lines.length === count + 1 && lines.at(-1) === "")) ||
      hashNormalizedLineText(lines.slice(0, count).join("\n")) !== descriptor.contentHash
    )
      return false;
    recordDeliveredFileRead(staged, fresh);
  }
  for (const { recordedAt: _recordedAt, ...entry } of staged.snapshot()) ledger.record(entry);
  return true;
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
