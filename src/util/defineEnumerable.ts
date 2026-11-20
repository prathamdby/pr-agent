export function defineEnumerable(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
