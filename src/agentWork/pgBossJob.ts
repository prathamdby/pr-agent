import type { JobWithMetadata } from "pg-boss";

export function isTerminalPgBossAttempt(job: JobWithMetadata<unknown>): boolean {
  return job.retryCount >= job.retryLimit;
}
