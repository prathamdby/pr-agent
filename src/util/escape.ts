/**
 * The single sanctioned type-assertion escape.
 *
 * `typescript/no-unsafe-type-assertion` is an error everywhere except this
 * file. When a value's shape was validated at a boundary that the type
 * system cannot see (intake applier, schema repair, session resume), call
 * this helper with the reason the assertion is safe instead of writing a
 * bare `as` cast. Every call is counted by
 * `scripts/check-static-baseline.mjs` under `escape-calls`, and the count
 * fails the gate on growth: a new call needs a baseline bump plus
 * maintainer review, so the escape stays a deliberate act, not a shortcut.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- ADR 0039 requires a caller-chosen return type.
export function escape<T>(reason: string, value: unknown): T {
  void reason;
  return value as T;
}
