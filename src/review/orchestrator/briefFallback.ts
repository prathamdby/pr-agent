import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import { DEFAULT_SPECIALIST_FOCUS, type SpecialistBrief } from "./briefTool.js";

/**
 * Deterministic specialist brief when recon fails to submit a valid brief after repair
 * (PR title/body + diff-index file list; persona default focus lines).
 */
export function buildDeterministicBrief(params: {
  readonly prTitle: string;
  readonly prBody: string;
  readonly cachedDiffIndex: CachedPrDiffIndex;
}): SpecialistBrief {
  const files = [...params.cachedDiffIndex.files.keys()].toSorted();
  const fileMap =
    files.length > 0 ? files.map((path) => `- ${path}`).join("\n") : "(no changed files indexed)";
  const title = params.prTitle.trim().length > 0 ? params.prTitle.trim() : "(untitled)";
  const body = params.prBody.trim();
  const prIntent =
    body.length > 0
      ? `${title}\n\n${body}`.slice(0, 2000)
      : `Pull request: ${title}`.slice(0, 2000);

  return {
    prIntent,
    architectureNotes: "Deterministic brief fallback — recon did not submit a validated brief.",
    riskAreas:
      files.length > 0
        ? [
            {
              area: "Changed files",
              files: files.slice(0, 20),
              reason: "All indexed changed paths from the server diff index.",
            },
          ]
        : [],
    fileMap: fileMap.slice(0, 6000),
    specialistFocus: { ...DEFAULT_SPECIALIST_FOCUS },
  };
}

/** Compact changed-files summary for the recon instruction. */
export function renderChangedFilesSummary(cachedDiffIndex: CachedPrDiffIndex): string {
  const files = [...cachedDiffIndex.files.keys()].toSorted();
  if (files.length === 0) return "(none indexed)";
  return files.map((path) => `- ${path}`).join("\n");
}
