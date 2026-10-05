/**
 * The single sanctioned type-assertion escape.
 *
 * The backend denies unsafe type assertions. The guard ledger counts remaining
 * assertions and escape calls against the merge base. A growth
 * waits on the `guard-loosening` environment. When a value's shape was
 * validated at a boundary the type system cannot see, call this helper with
 * the reason the assertion is safe instead of writing a bare `as` cast.
 */
export function escape<T>(reason: string, value: unknown): T {
  void reason;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ADR 0039 confines reviewed caller-proven narrowing to this line.
  return value as T;
}
