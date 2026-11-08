import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import {
  assertPathAllowedForAsk,
  isSensitivePath,
  pathAllowedForAsk,
  type AskPathGate,
} from "../ask/askSafety.ts";
import { isTriageControlPath, normalizeRepoRelativePath } from "../triage/triageWritePolicy.ts";
import { AppError } from "../../errors/appError.ts";
import {
  assertContainedWorkspacePath,
  assertWorkspacePath,
  type PathPolicy,
} from "../../prWorkspace/repositoryReader.ts";

export function createPathPolicy(
  root: string,
  profile:
    | { readonly kind: "investigation"; readonly gate: AskPathGate }
    | { readonly kind: "verification" | "triage" },
): PathPolicy {
  const normalize = (path: string) =>
    profile.kind === "investigation" ? path.replace(/\\/g, "/") : normalizeRepoRelativePath(path);
  const allows = (path: string) => {
    if (profile.kind === "investigation") return pathAllowedForAsk(path, profile.gate);
    if (profile.kind === "triage") return !isTriageControlPath(normalize(path));
    return !isSensitivePath(normalize(path));
  };
  const assertDiff = (path: string) => {
    const normalized = normalize(path);
    if (profile.kind === "investigation") assertPathAllowedForAsk(normalized, profile.gate);
    else if (!allows(normalized))
      throw new AppError({
        domain: profile.kind,
        kind: "sensitive_path_blocked",
        message: `Blocked sensitive path "${normalized}"`,
        context: { path: normalized },
      });
    assertWorkspacePath(root, normalized);
    return normalized;
  };
  return {
    allows,
    assertDiff,
    resolveRead: async (path) =>
      profile.kind === "investigation"
        ? assertWorkspacePath(root, assertDiff(path))
        : assertContainedWorkspacePath(root, assertDiff(path)),
    allowsSearch: (path) =>
      profile.kind === "investigation"
        ? Promise.resolve(allows(path))
        : isTriageSearchPathAllowed(root, path),
  };
}

async function isAllowedTriageSearchPath(
  root: string,
  realRoot: string,
  path: string,
): Promise<boolean> {
  const normalized = normalizeRepoRelativePath(path);
  if (!normalized || isTriageControlPath(normalized)) return false;

  try {
    const fullPath = assertWorkspacePath(root, normalized);
    const realCandidate = await realpath(fullPath);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
      return false;
    }
    const resolvedPath = normalizeRepoRelativePath(relative(realRoot, realCandidate));
    return !isTriageControlPath(resolvedPath);
  } catch {
    return false;
  }
}

export async function isTriageSearchPathAllowed(root: string, path: string): Promise<boolean> {
  return isAllowedTriageSearchPath(root, await realpath(root), path);
}
