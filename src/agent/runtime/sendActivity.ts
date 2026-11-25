import { AppError } from "../../errors/appError.ts";

export function createSendActivity(timeoutMs: number, sendAbort: AbortController) {
  const enabled = typeof timeoutMs === "number" && timeoutMs > 0;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let rejectOnIdle: ((error: Error) => void) | undefined;
  let lastActivityAt = Date.now();
  let rejected = false;
  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const timeoutError = () =>
    new AppError({
      domain: "pi",
      kind: "prompt_idle_timeout",
      message: `Provider prompt timeout: no activity for ${timeoutMs}ms`,
    });
  const rejectForIdle = () => {
    if (rejected) return;
    rejected = true;
    sendAbort.abort();
    rejectOnIdle?.(timeoutError());
  };
  return {
    markActivity,
    get rejected() {
      return rejected;
    },
    assertNotTimedOut() {
      if (rejected) throw timeoutError();
    },
    async run(work: Promise<void>) {
      void work.catch(() => undefined);
      if (!enabled) {
        await work;
        return;
      }
      let interval: ReturnType<typeof setInterval> | undefined;
      const idle = new Promise<never>((_, reject) => {
        rejectOnIdle = reject;
        markActivity();
        const checkEveryMs = Math.max(1, Math.min(timeoutMs, 1000));
        interval = setInterval(() => {
          if (Date.now() - lastActivityAt >= timeoutMs) rejectForIdle();
        }, checkEveryMs);
        timers.push(interval);
      });
      try {
        await Promise.race([work, idle]);
      } finally {
        if (interval !== undefined) {
          clearInterval(interval);
          const index = timers.indexOf(interval);
          if (index >= 0) timers.splice(index, 1);
        }
      }
    },
    dispose() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },
  };
}

export function sleepForRetry(ms: number, signal: AbortSignal) {
  return ((pinnedReturn: Promise<void>) => pinnedReturn)(
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  );
}
