const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/i;

export function parseEmbeddedJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(FENCED_JSON);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return ((pinnedReturn: unknown) => pinnedReturn)(undefined);
  return ((pinnedReturn: unknown) => pinnedReturn)(
    JSON.parse(candidate.slice(start, end + 1)) as unknown,
  );
}
