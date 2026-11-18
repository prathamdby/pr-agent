import * as v from "valibot";

export function formatValidationIssues(issues: readonly v.GenericIssue[], title: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      title,
      ...issues.map((issue) => `- ${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`),
    ].join("\n"),
  );
}
