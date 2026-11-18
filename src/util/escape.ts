export function escape<T>(reason: string, value: unknown) {
  void reason;
  return ((pinnedReturn: T) => pinnedReturn)(value as T);
}
