export function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      typeof code === "string" ? code : undefined,
    );
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
}

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
