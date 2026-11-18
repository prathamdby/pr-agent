const WILDCARD = "*/*";

type AcceptEntry = {
  readonly type: string;
  readonly q: number;
  readonly specificity: 0 | 1 | 2;
  readonly index: number;
};

export function parseQuality(parameters: readonly string[]) {
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
      return ((pinnedReturn: number) => pinnedReturn)(1);
    }
    return ((pinnedReturn: number) => pinnedReturn)(Math.min(1, Math.max(0, parsed)));
  }
  return ((pinnedReturn: number) => pinnedReturn)(1);
}

function specificityOf(type: string) {
  if (type === WILDCARD) {
    return ((pinnedReturn: 0 | 1 | 2) => pinnedReturn)(0);
  }
  return ((pinnedReturn: 0 | 1 | 2) => pinnedReturn)(type.endsWith("/*") ? 1 : 2);
}

export function parseAccept(header: string) {
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
  return ((pinnedReturn: readonly AcceptEntry[]) => pinnedReturn)(entries);
}

function matches(entry: AcceptEntry, candidate: string) {
  if (entry.type === WILDCARD) {
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  }
  if (entry.type.endsWith("/*")) {
    return ((pinnedReturn: boolean) => pinnedReturn)(candidate.startsWith(entry.type.slice(0, -1)));
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(entry.type === candidate);
}

function coversBetter(entry: AcceptEntry, incumbent: AcceptEntry) {
  if (entry.specificity !== incumbent.specificity) {
    return ((pinnedReturn: boolean) => pinnedReturn)(entry.specificity > incumbent.specificity);
  }
  if (entry.q !== incumbent.q) {
    return ((pinnedReturn: boolean) => pinnedReturn)(entry.q > incumbent.q);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(entry.index < incumbent.index);
}

function bestEntryFor(entries: readonly AcceptEntry[], candidate: string) {
  let best: AcceptEntry | null = null;
  for (const entry of entries) {
    if (!matches(entry, candidate)) {
      continue;
    }
    if (best === null || coversBetter(entry, best)) {
      best = entry;
    }
  }
  return ((pinnedReturn: AcceptEntry | null) => pinnedReturn)(best);
}

function outranks(entry: AcceptEntry, incumbent: AcceptEntry) {
  if (entry.q !== incumbent.q) {
    return ((pinnedReturn: boolean) => pinnedReturn)(entry.q > incumbent.q);
  }
  if (entry.specificity !== incumbent.specificity) {
    return ((pinnedReturn: boolean) => pinnedReturn)(entry.specificity > incumbent.specificity);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(entry.index < incumbent.index);
}

export function negotiateType(header: string | null | undefined, produces: readonly string[]) {
  const fallback = produces[0] ?? null;
  if (header === null || header === undefined) {
    return ((pinnedReturn: string | null) => pinnedReturn)(fallback);
  }
  const entries = parseAccept(header);
  if (entries.length === 0) {
    return ((pinnedReturn: string | null) => pinnedReturn)(header.trim() === "" ? null : fallback);
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
  return ((pinnedReturn: string | null) => pinnedReturn)(best);
}
