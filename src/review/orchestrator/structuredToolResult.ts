/**
 * Unified structured-tool executor envelope for brief, specialist report, thread, and summary.
 * Model-visible success/error shape is always `{accepted,value}` / `{accepted,error}`.
 */
export type StructuredToolAccepted<T> = {
  readonly accepted: true;
  readonly value: T;
};

export type StructuredToolRejected = {
  readonly accepted: false;
  readonly error: string;
};

export type StructuredToolResult<T> = StructuredToolAccepted<T> | StructuredToolRejected;

export function toolAccepted<T>(value: T): StructuredToolAccepted<T> {
  return { accepted: true, value };
}

export function toolRejected(error: string): StructuredToolRejected {
  return { accepted: false, error };
}
