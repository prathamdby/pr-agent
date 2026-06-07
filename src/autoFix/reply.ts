import { FIX_NOTHING_APPLIED } from "../settings/index.js";
import type { AutoFixTarget } from "./types.js";

type RenderAutoFixCommit = {
  readonly sha: string;
  readonly message: string;
};
type RenderAutoFixSkippedTarget = {
  readonly target: Pick<AutoFixTarget, "severity" | "filePath" | "startLine" | "title">;
  readonly reason: string;
};

export type AutoFixSkippedTarget = {
  readonly target: AutoFixTarget;
  readonly reason: string;
};

export function renderAutoFixFinalReply(params: {
  commits: readonly RenderAutoFixCommit[];
  fallbackPr?: { readonly url: string; readonly reused: boolean };
  skipped: readonly RenderAutoFixSkippedTarget[];
  changedPaths: readonly string[];
}): string {
  const lines: string[] = [];
  if (params.fallbackPr) {
    lines.push(
      params.fallbackPr.reused
        ? `Auto-fix updated replacement PR: ${params.fallbackPr.url}`
        : `Auto-fix opened replacement PR: ${params.fallbackPr.url}`,
    );
  } else if (params.commits.length > 0) {
    lines.push("Auto-fix applied commits:");
    for (const commit of params.commits) {
      lines.push(`- ${commit.sha.slice(0, 12)} ${commit.message}`);
    }
  } else {
    lines.push(FIX_NOTHING_APPLIED);
  }

  if (params.changedPaths.length > 0) {
    lines.push("");
    lines.push("Changed paths:");
    for (const path of params.changedPaths) {
      lines.push(`- \`${path}\``);
    }
  }

  if (params.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped:");
    for (const skipped of params.skipped) {
      lines.push(
        `- ${skipped.target.severity} \`${skipped.target.filePath}:${skipped.target.startLine}\` ${skipped.target.title}: ${skipped.reason}`,
      );
    }
  }

  return lines.join("\n");
}
