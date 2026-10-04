/**
 * The single sanctioned type-assertion escape.
 *
 * `typescript/no-unsafe-type-assertion` is off in `.oxlintrc.json`. The guard
 * ledger counts assertions and escape calls against the merge base. A growth
 * waits on the `guard-loosening` environment. When a value's shape was
 * validated at a boundary the type system cannot see, call this helper with
 * the reason the assertion is safe instead of writing a bare `as` cast.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- ADR 0039 requires a caller-chosen return type.
export function escape<T>(reason: string, value: unknown): T {
  void reason;
  return value as T;
}
