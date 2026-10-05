import { httpStatus } from "./httpStatus.js";
import { isAppError } from "../errors/appError.js";

/**
 * A provider contract proves non-acceptance only through an explicit flag or
 * a request error that cannot represent an accepted mutation.
 */
export function isKnownNoAcceptanceMutationError(error: unknown): boolean {
  if (
    isAppError(error) &&
    error.code === "github.review_thread_resolution_denied" &&
    error.context.mutationAccepted === false
  ) {
    return true;
  }
  if (typeof error !== "object" || error == null) return false;
  if (
    ("accepted" in error && error.accepted === false) ||
    ("mutationAccepted" in error && error.mutationAccepted === false)
  )
    return true;
  const response: unknown = "response" in error ? error.response : undefined;
  if (typeof response === "object" && response != null) {
    if (
      ("accepted" in response && response.accepted === false) ||
      ("mutationAccepted" in response && response.mutationAccepted === false)
    ) {
      return true;
    }
    const data: unknown = "data" in response ? response.data : undefined;
    if (typeof data === "object" && data != null) {
      if (
        ("accepted" in data && data.accepted === false) ||
        ("mutationAccepted" in data && data.mutationAccepted === false)
      )
        return true;
    }
  }
  const status = httpStatus(error);
  return status === 400 || status === 401 || status === 403 || status === 404;
}
