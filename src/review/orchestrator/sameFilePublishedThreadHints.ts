import type { ReviewFinding } from "../reviewSchema.js";

/** Compact same-file overlap hint for judgment prompts and publish_thread results. */
export type SameFilePublishedThreadHint = {
  readonly file: string;
  readonly title: string;
  readonly startLine: number;
  readonly endLine: number;
};

/**
 * Prior accepted/published findings that touch any file in `incoming`.
 * Used before judgment publish and again on publish_thread repair results (decision 23).
 */
export function sameFilePublishedThreadHints(
  incoming: readonly ReviewFinding[],
  previouslyAccepted: readonly ReviewFinding[],
): SameFilePublishedThreadHint[] {
  const incomingFiles = new Set(incoming.map((finding) => finding.file));
  const hints: SameFilePublishedThreadHint[] = [];
  for (const finding of previouslyAccepted) {
    if (!incomingFiles.has(finding.file)) continue;
    hints.push({
      file: finding.file,
      title: finding.title,
      startLine: finding.startLine,
      endLine: finding.endLine,
    });
  }
  return hints;
}
