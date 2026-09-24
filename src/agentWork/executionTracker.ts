export type ExecutionTracker = {
  readonly track: <T>(run: () => Promise<T>) => Promise<T>;
  readonly settle: (timeoutMs: number) => Promise<void>;
};

export function createExecutionTracker(): ExecutionTracker {
  const inFlight = new Set<Promise<void>>();

  return {
    track<T>(run: () => Promise<T>): Promise<T> {
      let promise: Promise<T>;
      try {
        promise = run();
      } catch (error) {
        promise = Promise.reject(error);
      }
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
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (inFlight.size === 0) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const pending = [...inFlight];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          await Promise.race([
            Promise.allSettled(pending).then(() => undefined),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true;
                resolve();
              }, remaining);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        if (timedOut) return;
      }
    },
  };
}
