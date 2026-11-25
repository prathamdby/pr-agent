export function pathsFromUnifiedDiff(diff: string) {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const bPath = parseDiffGitBPath(line.slice("diff --git ".length));
    if (bPath != null && bPath.length > 0) paths.push(bPath);
  }
  return ((pinnedReturn: readonly string[]) => pinnedReturn)([...new Set(paths)]);
}

const GIT_NAMED_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function unquoteGitPath(token: string) {
  if (!token.startsWith('"'))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      token.length > 0 ? token : undefined,
    );
  if (!token.endsWith('"') || token.length < 2)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  let ascii = "";
  const flush = () => {
    if (bytes.length === 0) return;
    ascii += Buffer.from(bytes).toString("utf8");
    bytes.length = 0;
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      flush();
      ascii += char;
      continue;
    }
    const next = body[index + 1];
    if (next == null) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
    const octal = body.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      index += 3;
      continue;
    }
    const named = GIT_NAMED_ESCAPES[next];
    flush();
    ascii += named ?? next;
    index += 1;
  }
  flush();
  return ((pinnedReturn: string | undefined) => pinnedReturn)(ascii);
}

function readDiffGitToken(text: string, start: number) {
  if (text[start] === '"') {
    const end = findClosingQuote(text, start);
    if (end < 0) return ((pinnedReturn: undefined) => pinnedReturn)(undefined);
    const raw = unquoteGitPath(text.slice(start, end + 1));
    if (raw === undefined) return ((pinnedReturn: undefined) => pinnedReturn)(undefined);
    return ((pinnedReturn: { readonly value: string; readonly end: number } | undefined) =>
      pinnedReturn)({ value: raw, end: end + 1 });
  }
  let end = start;
  while (end < text.length && text[end] !== " ") end += 1;
  if (end === start) return ((pinnedReturn: undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: { readonly value: string; readonly end: number } | undefined) =>
    pinnedReturn)({ value: text.slice(start, end), end });
}

function parseDiffGitBPath(rest: string) {
  if (rest.startsWith('"'))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(parseQuotedFirstPair(rest));
  return ((pinnedReturn: string | undefined) => pinnedReturn)(parseUnquotedFirstPair(rest));
}

function parseQuotedFirstPair(rest: string) {
  const aToken = readDiffGitToken(rest, 0);
  if (aToken === undefined || !aToken.value.startsWith("a/"))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (rest[aToken.end] !== " ")
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    decodeTailBPath(rest.slice(aToken.end + 1)),
  );
}

function decodeTailBPath(tail: string) {
  const value = tail.startsWith('"') ? decodeQuotedTail(tail) : tail;
  if (value === undefined || !value.startsWith("b/"))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(value.slice(2));
}

function decodeQuotedTail(tail: string) {
  const token = readDiffGitToken(tail, 0);
  if (token === undefined || token.end !== tail.length)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(token.value);
}

function parseUnquotedFirstPair(rest: string) {
  let fallback: string | undefined;
  for (const boundary of boundaryCandidates(rest)) {
    const aPath = rest.slice(0, boundary);
    if (!aPath.startsWith("a/")) continue;
    const bPath = decodeTailBPath(rest.slice(boundary + 1));
    if (bPath === undefined) continue;
    if (fallback === undefined) fallback = bPath;
    if (aPath.slice(2) === bPath)
      return ((pinnedReturn: string | undefined) => pinnedReturn)(bPath);
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(fallback);
}

function* boundaryCandidates(rest: string) {
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== " ") continue;
    const next = rest[index + 1];
    if (next === "b" || (next === '"' && rest[index + 2] === "b")) yield index;
  }
}

function findClosingQuote(text: string, start: number) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return ((pinnedReturn: number) => pinnedReturn)(index);
    index += 1;
  }
  return ((pinnedReturn: number) => pinnedReturn)(-1);
}
