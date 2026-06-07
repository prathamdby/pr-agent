import type { AutoFixTargetGroup } from "./types.js";

export function buildAutoFixSystemPrompt(): string {
  return [
    "You fix PR Agent review findings by using only the auto-fix tools.",
    "The visible working directory is scratch space. Do not rely on files in it.",
    "Read and edit repository files only through readFixFile, editFixFile, writeFixFile, and deleteFixPath.",
    "Keep changes minimal and directly tied to the target findings.",
    "Do not run tests, builds, shell commands, git commands, or package managers.",
    "Call submitAutoFixResult exactly once for the target group.",
  ].join("\n");
}

function formatTarget(index: number, target: AutoFixTargetGroup["targets"][number]): string {
  return [
    `Finding ${index + 1}`,
    `Lens: ${target.reviewLens}`,
    `Severity: ${target.severity}`,
    `Location: ${target.filePath}:${target.startLine}-${target.endLine}`,
    `Title: ${target.title}`,
    `Detail: ${target.detail}`,
    `Fix prompt: ${target.fixPrompt}`,
  ].join("\n");
}

export function buildAutoFixUserPrompt(params: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  group: AutoFixTargetGroup;
}): string {
  return [
    `Repository: ${params.owner}/${params.repo}`,
    `Pull request: #${params.prNumber}`,
    `Head SHA: ${params.headSha}`,
    "",
    "Fix this target group. If a finding is no longer valid, skip it and explain why.",
    "",
    params.group.targets.map((target, index) => formatTarget(index, target)).join("\n\n"),
  ].join("\n");
}
