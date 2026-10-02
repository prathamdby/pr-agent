import type { Pool, PoolClient } from "pg";
import { REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS } from "../settings/index.js";
import type { AnyReviewLens } from "../settings/legacyReviewLenses.js";

// Both retained-session lanes reserve from the same pool budget.
const reservations = new WeakMap<Pool, { count: number }>();

export type SessionLockKey =
  | {
      readonly kind: "own_verdict";
      readonly workItemId: string;
      readonly reviewLens: AnyReviewLens;
    }
  | { readonly kind: "progress"; readonly resourceKey: string; readonly reviewLens: AnyReviewLens };

type TrySessionLockOptions = {
  readonly mode: "try";
  readonly unleased: boolean;
  readonly capacityError: (poolMax: number) => Error;
  readonly onContended: (client: PoolClient) => Promise<unknown>;
};

type WaitSessionLockOptions = {
  readonly mode: "wait";
  readonly deadline: number;
  readonly capacityError: (poolMax: number) => Error;
  readonly timeoutError: Error;
  readonly onAcquireError: (error: unknown) => never;
  readonly onUnlockError: (error: unknown) => void;
};

export function withSessionLock<T>(
  pool: Pool,
  key: Extract<SessionLockKey, { kind: "progress" }>,
  options: WaitSessionLockOptions,
  apply: (client: PoolClient) => Promise<T>,
): Promise<T>;
export function withSessionLock<T>(
  pool: Pool,
  key: Extract<SessionLockKey, { kind: "own_verdict" }>,
  options: TrySessionLockOptions,
  apply: (client: PoolClient) => Promise<T>,
): Promise<T | undefined>;
export async function withSessionLock<T>(
  pool: Pool,
  key: SessionLockKey,
  options: TrySessionLockOptions | WaitSessionLockOptions,
  apply: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  const poolMax = pool.options.max ?? (key.kind === "own_verdict" ? 10 : 0);
  const capacity = Math.max(options.mode === "try" ? 1 : 0, Math.floor(poolMax / 2));
  if (capacity < 1 || (options.mode === "try" && poolMax === 1 && !options.unleased)) {
    throw options.capacityError(poolMax);
  }
  const lockKey =
    key.kind === "own_verdict"
      ? `own-verdict:${key.workItemId}:${key.reviewLens}`
      : JSON.stringify([key.resourceKey, key.reviewLens]);
  const reservation = reservations.get(pool) ?? { count: 0 };
  reservations.set(pool, reservation);
  const deadline = options.mode === "wait" ? options.deadline : Infinity;
  let attempt = 0;
  let retained: PoolClient | undefined;
  try {
    do {
      if (reservation.count < capacity) {
        reservation.count++;
        let client: PoolClient | undefined;
        let locked = false;
        let destroy = true;
        let acquireFailure: { readonly error: unknown } | undefined;
        try {
          client = await pool.connect();
          if (options.mode === "wait" && performance.now() >= deadline) throw options.timeoutError;
          const result = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
            [lockKey],
          );
          if (options.mode === "wait" && performance.now() >= deadline) throw options.timeoutError;
          destroy = false;
          locked = result.rows[0]?.locked ?? false;
          if (locked) {
            retained = client;
          } else if (options.mode === "try") {
            await options.onContended(client);
          }
        } catch (error) {
          acquireFailure = { error };
        } finally {
          if (!locked) {
            try {
              client?.release(destroy ? true : undefined);
            } catch (error) {
              acquireFailure ??= { error };
            } finally {
              reservation.count--;
            }
          }
        }
        if (acquireFailure != null) throw acquireFailure.error;
      }
      if (retained != null || options.mode === "try") break;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const delay =
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS[attempt++] ??
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS.at(-1) ??
        0;
      // No session or admission reservation survives contention backoff.
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    } while (performance.now() < deadline);
    if (retained == null && options.mode === "wait") throw options.timeoutError;
  } catch (error) {
    if (options.mode === "wait") options.onAcquireError(error);
    throw error;
  }
  if (retained == null) return undefined;
  const client = retained;
  let value: T | undefined;
  let failure: { readonly error: unknown } | undefined;
  let destroy = false;
  try {
    value = await apply(client);
  } catch (error) {
    failure = { error };
  } finally {
    try {
      const result = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
        [lockKey],
      );
      destroy = !(result.rows[0]?.unlocked ?? false);
    } catch (error) {
      destroy = true;
      failure ??= { error };
      if (options.mode === "wait") options.onUnlockError(error);
    } finally {
      try {
        client.release(destroy ? true : undefined);
      } catch (error) {
        failure ??= { error };
      } finally {
        reservation.count--;
      }
    }
  }
  if (failure != null) throw failure.error;
  return value;
}
