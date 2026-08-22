/**
 * Accept negotiation per RFC 9110 section 12.5.1.
 *
 * Substring matching gets this wrong: a real Chrome header ends in a catch-all at q=0.8, so
 * `accept.includes("text/markdown")` is false while `startsWith("text/html")` is true only by
 * luck of ordering. Rank by q, break ties by specificity, and honour `q=0` as a refusal.
 */

const WILDCARD = "*/*";

export type AcceptEntry = {
  /** Lowercased media range: `text/markdown`, `text/*`, or the catch-all. */
  readonly type: string;
  /** Quality factor, clamped to [0, 1]. Absent or unparseable means 1. */
  readonly q: number;
  /** 2 for a full type, 1 for a subtype wildcard, 0 for the catch-all. */
  readonly specificity: 0 | 1 | 2;
  /** Position in the header, used to break ties between equal ranges. */
  readonly index: number;
};

function parseQuality(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (parameter.slice(0, separator).trim().toLowerCase() !== "q") {
      continue;
    }
    const parsed = Number.parseFloat(parameter.slice(separator + 1).trim());
    if (Number.isNaN(parsed)) {
      return 1;
    }
    return Math.min(1, Math.max(0, parsed));
  }
  return 1;
}

function specificityOf(type: string): 0 | 1 | 2 {
  if (type === WILDCARD) {
    return 0;
  }
  return type.endsWith("/*") ? 1 : 2;
}

export function parseAccept(header: string): readonly AcceptEntry[] {
  const entries: AcceptEntry[] = [];
  for (const raw of header.split(",")) {
    const parts = raw.split(";");
    const type = parts[0].trim().toLowerCase();
    if (type === "" || !type.includes("/")) {
      continue;
    }
    entries.push({
      type,
      q: parseQuality(parts.slice(1)),
      specificity: specificityOf(type),
      index: entries.length,
    });
  }
  return entries;
}

function matches(entry: AcceptEntry, candidate: string): boolean {
  if (entry.type === WILDCARD) {
    return true;
  }
  if (entry.type.endsWith("/*")) {
    return candidate.startsWith(entry.type.slice(0, -1));
  }
  return entry.type === candidate;
}

/**
 * Rank two entries covering the same candidate. The more specific range speaks for it, per the
 * RFC; between equally specific ranges the higher q wins, then the one the client listed first.
 * The q tie-break matters for a duplicated range: `text/markdown;q=0, text/markdown;q=0.9` is a
 * 0.9 ask, not a refusal.
 */
function coversBetter(entry: AcceptEntry, incumbent: AcceptEntry): boolean {
  if (entry.specificity !== incumbent.specificity) {
    return entry.specificity > incumbent.specificity;
  }
  if (entry.q !== incumbent.q) {
    return entry.q > incumbent.q;
  }
  return entry.index < incumbent.index;
}

/** The header entry that speaks for `candidate`, or null when none covers it. */
function bestEntryFor(entries: readonly AcceptEntry[], candidate: string): AcceptEntry | null {
  let best: AcceptEntry | null = null;
  for (const entry of entries) {
    if (!matches(entry, candidate)) {
      continue;
    }
    if (best === null || coversBetter(entry, best)) {
      best = entry;
    }
  }
  return best;
}

/**
 * Rank two matched entries: quality first, then how specifically each was asked for, then the
 * order the client listed them. A full tie leaves the earlier `produces` entry in place, so
 * server preference settles whatever the client left open.
 */
function outranks(entry: AcceptEntry, incumbent: AcceptEntry): boolean {
  if (entry.q !== incumbent.q) {
    return entry.q > incumbent.q;
  }
  if (entry.specificity !== incumbent.specificity) {
    return entry.specificity > incumbent.specificity;
  }
  return entry.index < incumbent.index;
}

/**
 * Pick the representation to serve.
 *
 * `produces` is server preference order, so `produces[0]` is what an unconstrained client gets.
 * Returns null when every representation is unacceptable, which is the only case that earns a 406.
 * A missing header means "no constraint" rather than "nothing works"; an empty one is a real
 * constraint that nothing can satisfy.
 */
export function negotiateType(
  header: string | null | undefined,
  produces: readonly string[],
): string | null {
  const fallback = produces[0] ?? null;
  if (header === null || header === undefined) {
    return fallback;
  }
  const entries = parseAccept(header);
  if (entries.length === 0) {
    return header.trim() === "" ? null : fallback;
  }

  let best: string | null = null;
  let bestEntry: AcceptEntry | null = null;
  for (const candidate of produces) {
    const entry = bestEntryFor(entries, candidate);
    if (entry === null || entry.q === 0) {
      continue;
    }
    if (bestEntry === null || outranks(entry, bestEntry)) {
      best = candidate;
      bestEntry = entry;
    }
  }
  return best;
}
