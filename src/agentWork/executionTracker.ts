export type ExecutionTracker = {
  readonly track: <T>(run: () => Promise<T>) => Promise<T>;
  readonly settle: (timeoutMs: number) => Promise<void>;
};

export function createExecutionTracker(): ExecutionTracker {
  const inFlight = new Set<Promise<void>>();

  return {
    track<T>(run: () => Promise<T>): Promise<T> {
      const promise = run();
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      inFlight.add(settled);
      void settled.then(() => {
        inFlight.delete(settled);
      });
      return promise;
    },
    async settle(timeoutMs: number): Promise<void> {
      if (inFlight.size === 0) {
        return;
      }
      const snapshot = [...inFlight];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(snapshot).then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}
