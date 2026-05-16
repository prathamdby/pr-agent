import { log } from "../log.js";

type Task<T> = () => Promise<T>;

let active = 0;
let maxConcurrent = 2;
const waiters: Array<() => void> = [];

export function configureReviewQueue(limit: number): void {
  maxConcurrent = Math.max(1, Math.floor(limit));
}

async function acquire(): Promise<void> {
  if (active < maxConcurrent) {
    active += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
  active += 1;
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

export async function runQueuedReview<T>(label: string, task: Task<T>): Promise<T> {
  const queuedAt = Date.now();
  await acquire();
  const waitMs = Date.now() - queuedAt;
  if (waitMs > 0) {
    log.info("review_queue_wait", { label, waitMs, active, maxConcurrent });
  }

  try {
    return await task();
  } finally {
    release();
  }
}
