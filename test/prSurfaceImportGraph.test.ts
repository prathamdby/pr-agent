import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportedSignatureTexts,
  forbiddenExportedParam,
  hasForbiddenImportReference,
} from "./architectureRulesHelpers.js";

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

describe("PR surface import graph", () => {
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
