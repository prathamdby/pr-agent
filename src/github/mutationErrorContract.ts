import { httpStatus } from "./httpStatus.js";

/**
 * A provider contract proves non-acceptance only through an explicit flag or
 * a request error that cannot represent an accepted mutation.
 */
export function isKnownNoAcceptanceMutationError(error: unknown): boolean {
  if (typeof error !== "object" || error == null) return false;
  const value = error as Record<string, unknown>;
  if (value.accepted === false || value.mutationAccepted === false) return true;
  const response = value.response;
  if (typeof response === "object" && response != null) {
    const responseValue = response as Record<string, unknown>;
    if (responseValue.accepted === false || responseValue.mutationAccepted === false) {
      return true;
    }
    const data = responseValue.data;
    if (typeof data === "object" && data != null) {
      const dataValue = data as Record<string, unknown>;
      if (dataValue.accepted === false || dataValue.mutationAccepted === false) return true;
    }
  }
  const status = httpStatus(error);
  return status === 400 || status === 401 || status === 403 || status === 404;
}
