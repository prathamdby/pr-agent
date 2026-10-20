export function escape<T>(reason: string, value: unknown): T {
  void reason;
  return value as T;
}
