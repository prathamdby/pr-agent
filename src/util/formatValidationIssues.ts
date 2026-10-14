import * as v from "valibot";

export function formatValidationIssues(issues: readonly v.GenericIssue[], title: string): string {
  return [
    title,
    ...issues.map((issue) => `- ${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`),
  ].join("\n");
}
