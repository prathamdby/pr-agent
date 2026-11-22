import * as v from "valibot";

export function reviewBaseSha(pullRequest: unknown) {
  const parsed = v.safeParse(
    v.object({
      base: v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40,64}$/)) }),
    }),
    pullRequest,
  );
  return ((pinnedReturn: string | null) => pinnedReturn)(
    parsed.success ? parsed.output.base.sha : null,
  );
}
