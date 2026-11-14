import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_REVISION_FILE = "REVISION";
const GIT_COMMIT_SHA = /^[0-9a-f]{40}$/;

export function readAppRevision(dir: string = process.cwd()): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(join(dir, APP_REVISION_FILE), "utf8");
  } catch {
    return undefined;
  }
  const revision = contents.trim();
  return GIT_COMMIT_SHA.test(revision) ? revision : undefined;
}
