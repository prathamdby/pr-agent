import type { Pool } from "pg";
import { withSessionLock } from "../../db/sessionLock.js";
import { AppError } from "../../errors/appError.js";
import { errorMessage } from "../../errors/errorMessage.js";
import { logWarn } from "../../evlog.js";
import { POSTGRES_LOCK_TIMEOUT_MS } from "../../settings/index.js";

export type ThreadMutationLock = <T>(apply: () => Promise<T>) => Promise<T>;

export function threadMutationLock(
  pool: Pool | undefined,
  resourceKey: string,
): ThreadMutationLock {
  if (pool == null) return (apply) => apply();
  return (apply) =>
    withSessionLock(
      pool,
      { kind: "thread_mutation", resourceKey },
      {
        mode: "wait",
        deadline: performance.now() + POSTGRES_LOCK_TIMEOUT_MS,
        capacityError: (poolMax) =>
          new AppError({
            domain: "agent_work",
            kind: "thread_mutation_lock_capacity",
            message: "Thread mutation needs a pool with at least two connections",
            context: { poolMax },
          }),
        timeoutError: new AppError({
          domain: "agent_work",
          kind: "thread_mutation_lock_timeout",
          message: "Thread mutation lock acquisition timed out",
          context: { timeoutMs: POSTGRES_LOCK_TIMEOUT_MS },
        }),
        onAcquireError: (error) => {
          throw error instanceof AppError
            ? error
            : new AppError({
                domain: "agent_work",
                kind: "thread_mutation_lock_failed",
                message: "Thread mutation lock acquisition failed",
                cause: error,
              });
        },
        onUnlockError: (error) => {
          logWarn("thread_mutation_unlock_failed", { resourceKey, message: errorMessage(error) });
        },
      },
      () => apply(),
    );
}
