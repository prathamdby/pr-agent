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
import { normalizeEvidencePath } from "../../review/findings/evidenceLedger.ts";
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
) {
  const normalize = (path: string) =>
    profile.kind === "triage" ? normalizeRepoRelativePath(path) : normalizeEvidencePath(path);
  const allows = (path: string) => {
    if (profile.kind === "investigation") return pathAllowedForAsk(path, profile.gate);
    const normalized = normalize(path);
    return profile.kind === "triage"
      ? !isTriageControlPath(normalized)
      : !isSensitivePath(normalized);
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
  return ((pinnedReturn: PathPolicy) => pinnedReturn)({
    allows,
    assertDiff,
    resolveRead: async (path) => assertContainedWorkspacePath(root, assertDiff(path)),
    allowsSearch: (path) =>
      profile.kind === "investigation"
        ? Promise.resolve(allows(path))
        : isTriageSearchPathAllowed(root, path),
  });
}

async function isAllowedTriageSearchPath(root: string, realRoot: string, path: string) {
  const normalized = normalizeRepoRelativePath(path);
  if (!normalized || isTriageControlPath(normalized))
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);

  try {
    const fullPath = assertWorkspacePath(root, path);
    const realCandidate = await realpath(fullPath);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
      return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
    }
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(
      !isTriageControlPath(relative(realRoot, realCandidate)),
    );
  } catch {
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  }
}

export async function isTriageSearchPathAllowed(root: string, path: string) {
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(
    isAllowedTriageSearchPath(root, await realpath(root), path),
  );
}
