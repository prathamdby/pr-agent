import { parseQuality } from "./accept.ts";

export const PROGRAMMING_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "go",
  "java",
  "ruby",
  "bash",
] as const;

export type ProgrammingLanguage = (typeof PROGRAMMING_LANGUAGES)[number];

export const DEFAULT_PROGRAMMING_LANGUAGE = "typescript" satisfies ProgrammingLanguage;

export type ServableLanguages = readonly [ProgrammingLanguage, ...ProgrammingLanguage[]];

const SPELLINGS = new Map<string, ProgrammingLanguage>([
  ...PROGRAMMING_LANGUAGES.map((language): [string, ProgrammingLanguage] => [language, language]),
  ["golang", "go"],
  ["shell", "bash"],
]);

type Preference = {
  readonly q: number;
  readonly index: number;
};

function preferences(header: string): Map<ProgrammingLanguage, Preference> {
  const asked = new Map<ProgrammingLanguage, Preference>();
  for (const [index, raw] of header.split(",").entries()) {
    const parts = raw.split(";");
    const language = SPELLINGS.get(parts[0].trim().toLowerCase());
    if (language === undefined) {
      continue;
    }
    const q = parseQuality(parts.slice(1));
    const current = asked.get(language);
    if (current === undefined || q > current.q) {
      asked.set(language, { q, index });
    }
  }
  return asked;
}

function outranks(entry: Preference, incumbent: Preference): boolean {
  return entry.q === incumbent.q ? entry.index < incumbent.index : entry.q > incumbent.q;
}

export function negotiateProgrammingLanguage(
  header: string | null | undefined,
  produces: ServableLanguages,
): ProgrammingLanguage {
  if (header === null || header === undefined) {
    return produces[0];
  }
  const asked = preferences(header);
  let best: ProgrammingLanguage | null = null;
  let bestPreference: Preference | null = null;
  for (const candidate of produces) {
    const preference = asked.get(candidate);
    if (preference === undefined || preference.q === 0) {
      continue;
    }
    if (bestPreference === null || outranks(preference, bestPreference)) {
      best = candidate;
      bestPreference = preference;
    }
  }
  if (best !== null) {
    return best;
  }
  return produces.find((candidate) => asked.get(candidate)?.q !== 0) ?? produces[0];
}
