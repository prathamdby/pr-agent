export function httpStatus(error: unknown) {
  if (typeof error !== "object" || error === null)
    return ((pinnedReturn: number | undefined) => pinnedReturn)(undefined);
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number")
    return ((pinnedReturn: number | undefined) => pinnedReturn)(status);
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null)
    return ((pinnedReturn: number | undefined) => pinnedReturn)(undefined);
  const responseStatus = (response as { status?: unknown }).status;
  return ((pinnedReturn: number | undefined) => pinnedReturn)(
    typeof responseStatus === "number" ? responseStatus : undefined,
  );
}

export function allowlistedHttpStatus(status: number | undefined) {
  if (status == null || !Number.isInteger(status) || status < 100 || status > 599) {
    return ((pinnedReturn: number | undefined) => pinnedReturn)(undefined);
  }
  return ((pinnedReturn: number | undefined) => pinnedReturn)(status);
}
