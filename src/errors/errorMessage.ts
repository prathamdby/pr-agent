export function errorMessage(error: unknown) {
  return ((pinnedReturn: string) => pinnedReturn)(
    error instanceof Error ? error.message : String(error),
  );
}

export function toError(error: unknown) {
  return ((pinnedReturn: Error) => pinnedReturn)(
    error instanceof Error ? error : new Error(String(error)),
  );
}
