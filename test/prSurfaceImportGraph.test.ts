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
  return walkTsFiles(SRC_ROOT).filter((file) => !file.startsWith(`${GITHUB_ROOT}/`));
}

function exportedSignatureLines(text: string): string[] {
  const lines: string[] = [];
  const exportPattern =
    /^export\s+(?:async\s+)?(?:function|type|interface|const|class)\s+([A-Za-z0-9_]+)/;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!exportPattern.test(trimmed)) continue;
    if (!trimmed.includes("(") && !trimmed.includes("{")) continue;
    lines.push(trimmed);
  }
  return lines;
}

function forbiddenExportedParam(line: string): string | undefined {
  if (/\btoken:\s*string\b/.test(line)) return "token: string";
  if (/\bexpiresAtTs\b/.test(line)) return "expiresAtTs";
  if (/\btokenExpiresAtTs\b/.test(line)) return "tokenExpiresAtTs";
  return undefined;
}

describe("PR surface import graph", () => {
  it("keeps @octokit imports inside src/github/", () => {
    const violations: string[] = [];
    for (const file of filesOutsideGithub()) {
      const text = readFileSync(file, "utf8");
      if (/@octokit\//.test(text)) {
        violations.push(relative(process.cwd(), file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps installationOctokit references inside src/github/", () => {
    const violations: string[] = [];
    for (const file of filesOutsideGithub()) {
      const text = readFileSync(file, "utf8");
      if (/\binstallationOctokit\b/.test(text)) {
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
      for (const line of exportedSignatureLines(text)) {
        const reason = forbiddenExportedParam(line);
        if (reason != null) {
          violations.push({ file: relative(process.cwd(), file), line, reason });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
