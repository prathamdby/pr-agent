/**
 * Programming-language preference from Accept-Language.
 *
 * An agent puts a programming language after its locale (`Accept-Language: en-US, python`) to ask
 * for code examples in that language. The header is shared with natural-language tags, so only a
 * full-word match counts. `ts` is Tsonga and `sh` is Serbo-Croatian before they are anything else.
 * Media ranges stay in `accept.ts`. Nothing here reads a `/`.
 */

import { parseQuality } from "./accept.js";

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

/** Languages a response can serve, server preference first. Never empty, so a miss always has an answer. */
export type ServableLanguages = readonly [ProgrammingLanguage, ...ProgrammingLanguage[]];

/** Every spelling that names a listed language. Two-letter codes are locale tags, never aliases. */
const SPELLINGS = new Map<string, ProgrammingLanguage>([
  ...PROGRAMMING_LANGUAGES.map((language): [string, ProgrammingLanguage] => [language, language]),
  ["golang", "go"],
  ["shell", "bash"],
]);

type Preference = {
  /** Quality factor, clamped to [0, 1]. Absent or unparseable means 1. */
  readonly q: number;
  /** Position in the header, used to break ties between equal q. */
  readonly index: number;
};

/** The strongest q the client gave each listed language. A duplicated token speaks at its highest q. */
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

/**
 * Pick the language to render examples in.
 *
 * `produces` is server preference order, so `produces[0]` is what a client gets when it names no
 * listed language. A refusal (`q=0`) skips that language and the next servable one is served. A
 * client that refuses everything gets the default anyway. A miss never earns a 406, because the
 * locale half of the header is not ours to judge.
 */
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
