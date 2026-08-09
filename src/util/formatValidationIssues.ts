import * as v from "valibot";

/** Human-readable multi-line validation error for tool validation messages. */
export function formatValidationIssues(issues: readonly v.GenericIssue[], title: string): string {
  return [
    title,
    ...issues.map((issue) => `- ${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`),
  ].join("\n");
}
