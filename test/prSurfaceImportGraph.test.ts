import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");
const GITHUB_ROOT = join(SRC_ROOT, "github");

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function filesOutsideGithub(): string[] {
  return walkTsFiles(SRC_ROOT).filter(
    (file) => !file.startsWith(`${GITHUB_ROOT}/`) && !file.startsWith(`${SRC_ROOT}/prWorkspace/`),
  );
}

const EXPORT_DECLARATION =
  /^export\s+(?:async\s+)?(?:function|type|interface|const|class)\s+[A-Za-z0-9_]+/;

/** Strip block comments, line comments, and string literals for import-reference scans. */
export function stripCommentsAndStringLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function hasForbiddenImportReference(text: string, identifier: string): boolean {
  const stripped = stripCommentsAndStringLiterals(text);
  if (identifier === "@octokit") {
    return /\bfrom\s+["']@octokit\//.test(stripped) || /\bimport\s+["']@octokit\//.test(stripped);
  }
  if (identifier === "installationOctokit") {
    return /\binstallationOctokit\b/.test(stripped);
  }
  return false;
}

/** Collect full exported declaration signatures, including multi-line parameter lists. */
export function exportedSignatureTexts(text: string): string[] {
  const lines = text.split("\n");
  const signatures: string[] = [];
  let collecting = false;
  let buffer = "";
  let depth = 0;

  const updateDepth = (chunk: string): void => {
    for (const ch of chunk) {
      if (ch === "(" || ch === "{") depth += 1;
      if (ch === ")" || ch === "}") depth -= 1;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!collecting) {
      if (!EXPORT_DECLARATION.test(trimmed)) continue;
      if (!trimmed.includes("(") && !trimmed.includes("{")) continue;
      collecting = true;
      buffer = trimmed;
      depth = 0;
      updateDepth(trimmed);
      if (depth <= 0 && (trimmed.includes(")") || trimmed.includes("}"))) {
        signatures.push(buffer);
        collecting = false;
        buffer = "";
      }
      continue;
    }

    buffer += ` ${trimmed}`;
    updateDepth(trimmed);
    if (depth <= 0) {
      signatures.push(buffer.trim());
      collecting = false;
      buffer = "";
    }
  }

  return signatures;
}

function functionParameterList(signature: string): string | null {
  const open = signature.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return signature.slice(open + 1, i);
    }
  }
  return null;
}

export function forbiddenExportedParam(text: string): string | undefined {
  if (/\bgitCredentialAuth\b/.test(text)) return undefined;
  const params = functionParameterList(text);
  const scope = params ?? text;
  if (/\btoken:\s*string\b/.test(scope)) return "token: string";
  if (/\bexpiresAtTs\b/.test(scope)) return "expiresAtTs";
  if (/\btokenExpiresAtTs\b/.test(scope)) return "tokenExpiresAtTs";
  return undefined;
}

describe("PR surface import graph", () => {
  it("keeps @octokit imports inside src/github/", () => {
    const violations: string[] = [];
    for (const file of filesOutsideGithub()) {
      const text = readFileSync(file, "utf8");
      if (hasForbiddenImportReference(text, "@octokit")) {
        violations.push(relative(process.cwd(), file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps installationOctokit references inside src/github/", () => {
    const violations: string[] = [];
    for (const file of filesOutsideGithub()) {
      const text = readFileSync(file, "utf8");
      if (hasForbiddenImportReference(text, "installationOctokit")) {
        violations.push(relative(process.cwd(), file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not export installation-token parameters outside src/github/", () => {
    const violations: Array<{ file: string; line: string; reason: string }> = [];
    for (const file of filesOutsideGithub()) {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const signature of exportedSignatureTexts(text)) {
        const reason = forbiddenExportedParam(signature);
        if (reason != null) {
          violations.push({ file: relative(process.cwd(), file), line: signature, reason });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("flags multi-line exported token parameters", () => {
    const fixture = `
export function buildThing(
  owner: string,
  token: string,
): void {}
`;
    const signatures = exportedSignatureTexts(fixture);
    expect(signatures).toHaveLength(1);
    expect(forbiddenExportedParam(signatures[0])).toBe("token: string");
  });

  it("does not flag comment-only installationOctokit mentions", () => {
    const fixture = `
// installationOctokit is only used under src/github/
/* @octokit/rest example */
const x = "installationOctokit";
import { foo } from "../agent/foo.js";
`;
    expect(hasForbiddenImportReference(fixture, "installationOctokit")).toBe(false);
    expect(hasForbiddenImportReference(fixture, "@octokit")).toBe(false);
  });
});
