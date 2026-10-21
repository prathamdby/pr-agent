import { logWarn } from "../evlog.ts";

export const TRANSIENT_CONNECT_ATTEMPTS = 8;

const TRANSIENT_CONNECT_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

const TRANSIENT_CONNECT_BASE_DELAY_MS = 250;
const TRANSIENT_CONNECT_MAX_DELAY_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function connectCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function delayForAttempt(attempt: number): number {
  const exponent = Math.min(attempt - 1, 3);
  return Math.min(TRANSIENT_CONNECT_BASE_DELAY_MS * 2 ** exponent, TRANSIENT_CONNECT_MAX_DELAY_MS);
}

export async function retryTransientConnect<T>(
  operation: () => Promise<T>,
  sleep: (delayMs: number) => Promise<void> = delay,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = connectCode(error);
      if (
        code == null ||
        !TRANSIENT_CONNECT_CODES.has(code) ||
        attempt >= TRANSIENT_CONNECT_ATTEMPTS
      ) {
        throw error;
      }
      logWarn("postgres_connect_retry", { code, attempt });
      await sleep(delayForAttempt(attempt));
    }
  }
}
