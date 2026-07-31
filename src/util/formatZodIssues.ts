import type { z } from "zod";

/** Human-readable multi-line Zod error for tool validation messages. */
export function formatZodIssues(error: z.ZodError, title: string): string {
  return [
    title,
    ...error.issues.map(
      (issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    ),
  ].join("\n");
}
