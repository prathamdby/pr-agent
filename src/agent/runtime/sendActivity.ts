import { AppError } from "../../errors/appError.js";

/** A send may race several Core invocations; all of its monitors share activity. */
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
      code: "pi.prompt_idle_timeout",
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
    async run(work: Promise<void>): Promise<void> {
      void work.catch(() => undefined);
      if (!enabled) {
        await work;
        return;
      }
      const idle = new Promise<never>((_, reject) => {
        rejectOnIdle = reject;
        markActivity();
        const checkEveryMs = Math.max(1, Math.min(timeoutMs, 1000));
        timers.push(
          setInterval(() => {
            if (Date.now() - lastActivityAt >= timeoutMs) rejectForIdle();
          }, checkEveryMs),
        );
      });
      await Promise.race([work, idle]);
    },
    dispose() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },
  };
}

/** Retry waits share the send signal and release their abort listener on settlement. */
export function sleepForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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
  });
}
