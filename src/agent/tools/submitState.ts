export type IdleSubmitState<T> = {
  submitted: boolean;
  lastValidationError: string | null;
  payload: T | null;
};

export function createIdleSubmitState<T>() {
  return ((pinnedReturn: IdleSubmitState<T>) => pinnedReturn)({
    submitted: false,
    lastValidationError: null,
    payload: null,
  });
}
