export type TrackOptions = {
  readonly durable?: boolean;
};

export type SettleOptions = {
  readonly durableOnly?: boolean;
};

export type SettleResult = {
  readonly pendingHandlers: number;
  readonly pendingDurable: number;
};

export type ExecutionTracker = {
  readonly track: <T>(run: () => Promise<T>, options?: TrackOptions) => Promise<T>;
  readonly settle: (timeoutMs: number, options?: SettleOptions) => Promise<SettleResult>;
};

export function createExecutionTracker() {
  const inFlight = new Set<Promise<void>>();
  const durableInFlight = new Set<Promise<void>>();

  const pending = () =>
    ((pinnedReturn: SettleResult) => pinnedReturn)({
      pendingHandlers: inFlight.size - durableInFlight.size,
      pendingDurable: durableInFlight.size,
    });

  return ((pinnedReturn: ExecutionTracker) => pinnedReturn)({
    track<T>(run: () => Promise<T>, options: TrackOptions = {}) {
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
      if (options.durable) durableInFlight.add(settled);
      void settled.then(() => {
        inFlight.delete(settled);
        durableInFlight.delete(settled);
      });
      return ((pinnedReturn: Promise<T>) => pinnedReturn)(promise);
    },
    async settle(timeoutMs: number, options: SettleOptions = {}) {
      const watched = options.durableOnly ? durableInFlight : inFlight;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (watched.size === 0)
          return ((pinnedReturn: SettleResult | Promise<SettleResult>) => pinnedReturn)(pending());
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          return ((pinnedReturn: SettleResult | Promise<SettleResult>) => pinnedReturn)(pending());
        const pendingNow = [...watched];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          await Promise.race([
            Promise.allSettled(pendingNow).then(() => undefined),
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
        if (timedOut)
          return ((pinnedReturn: SettleResult | Promise<SettleResult>) => pinnedReturn)(pending());
      }
    },
  });
}
