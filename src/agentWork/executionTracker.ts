export type TrackOptions = {
  /**
   * Durable queue dispatches carry terminal work-item marks. Shutdown settles
   * all handlers first, then gives only these dispatches one more bounded wait
   * before the pool may end.
   */
  readonly durable?: boolean;
};

export type SettleOptions = {
  /** Wait only for dispatches tracked with `durable: true`. */
  readonly durableOnly?: boolean;
};

export type SettleResult = {
  /** Queue callbacks still in flight, excluding the inner durable dispatches. */
  readonly pendingHandlers: number;
  /** Durable dispatches still in flight. */
  readonly pendingDurable: number;
};

export type ExecutionTracker = {
  readonly track: <T>(run: () => Promise<T>, options?: TrackOptions) => Promise<T>;
  readonly settle: (timeoutMs: number, options?: SettleOptions) => Promise<SettleResult>;
};

export function createExecutionTracker(): ExecutionTracker {
  const inFlight = new Set<Promise<void>>();
  const durableInFlight = new Set<Promise<void>>();

  const pending = (): SettleResult => ({
    pendingHandlers: inFlight.size - durableInFlight.size,
    pendingDurable: durableInFlight.size,
  });

  return {
    track<T>(run: () => Promise<T>, options: TrackOptions = {}): Promise<T> {
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
      return promise;
    },
    async settle(timeoutMs: number, options: SettleOptions = {}): Promise<SettleResult> {
      const watched = options.durableOnly ? durableInFlight : inFlight;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (watched.size === 0) return pending();
        const remaining = deadline - Date.now();
        if (remaining <= 0) return pending();
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
        if (timedOut) return pending();
      }
    },
  };
}
