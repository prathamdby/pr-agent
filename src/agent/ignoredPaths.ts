import { DEFAULT_REVIEW_IGNORE_GLOBS } from "../settings/index.js";

const REGEX_SPECIAL = new Set("\\.+^$()|[]{}".split(""));

function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) return [glob];
  const pre = glob.slice(0, open);
  const post = glob.slice(close + 1);
  const body = glob.slice(open + 1, close);
  const options: string[] = [];
  let bodyDepth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") bodyDepth++;
    else if (body[i] === "}") bodyDepth--;
    else if (body[i] === "," && bodyDepth === 0) {
      options.push(body.slice(start, i));
      start = i + 1;
    }
  }
  options.push(body.slice(start));
  return options.flatMap((opt) => expandBraces(`${pre}${opt}${post}`));
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      const prevSlash = i === 0 || glob[i - 1] === "/";
      if (glob[i + 1] === "*") {
        if (prevSlash && glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (REGEX_SPECIAL.has(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

export function compileIgnoreGlobs(globs: readonly string[]): readonly RegExp[] {
  return globs.flatMap(expandBraces).map(globToRegExp);
}

const DEFAULT_IGNORE_MATCHERS = compileIgnoreGlobs(DEFAULT_REVIEW_IGNORE_GLOBS);

/** True when a repo-relative path matches a default review ignore glob. */
export function isIgnoredReviewPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return DEFAULT_IGNORE_MATCHERS.some((re) => re.test(normalized));
}
