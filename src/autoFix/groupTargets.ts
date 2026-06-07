import { REVIEW_SEVERITY_RANK } from "../settings/index.js";
import type { AutoFixTarget, AutoFixTargetGroup } from "./types.js";

function compareTargets(a: AutoFixTarget, b: AutoFixTarget): number {
  return (
    a.filePath.localeCompare(b.filePath) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine ||
    REVIEW_SEVERITY_RANK[a.severity] - REVIEW_SEVERITY_RANK[b.severity] ||
    a.title.localeCompare(b.title)
  );
}

function overlaps(a: AutoFixTarget, b: AutoFixTarget): boolean {
  return a.filePath === b.filePath && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

export function groupAutoFixTargets(targets: readonly AutoFixTarget[]): AutoFixTargetGroup[] {
  const sorted = [...targets].toSorted(compareTargets);
  const groups: AutoFixTargetGroup[] = [];

  for (const target of sorted) {
    const last = groups[groups.length - 1];
    if (!last) {
      groups.push({ targets: [target] });
      continue;
    }
    const sameFileOverlap = last.targets.some((existing) => overlaps(existing, target));
    if (sameFileOverlap) {
      groups[groups.length - 1] = { targets: [...last.targets, target] };
      continue;
    }
    groups.push({ targets: [target] });
  }

  return groups;
}
