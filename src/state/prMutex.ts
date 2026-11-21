const chains = new Map<string, Promise<void>>();

export async function withPrMutex<T>(prKey: string, fn: () => Promise<T>) {
  const prior = chains.get(prKey) ?? Promise.resolve();
  const run = prior.then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(prKey, tail);
  try {
    return ((pinnedReturn: T | Promise<T>) => pinnedReturn)(await run);
  } finally {
    if (chains.get(prKey) === tail) chains.delete(prKey);
  }
}
