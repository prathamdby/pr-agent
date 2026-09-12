export function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return status;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const responseStatus = (response as { status?: unknown }).status;
  return typeof responseStatus === "number" ? responseStatus : undefined;
}

export function allowlistedHttpStatus(status: number | undefined): number | undefined {
  if (status == null || !Number.isInteger(status) || status < 100 || status > 599) {
    return undefined;
  }
  return status;
}
