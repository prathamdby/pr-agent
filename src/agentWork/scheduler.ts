import { Context, Duration, Effect } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { type Config, HEALTH_DB_PING_TIMEOUT_MS } from "../settings/index.js";
import type { RequestLogger } from "../evlog.js";
import { toError } from "../errors/errorMessage.js";
import { runDelivery, type IntakeCommand } from "./intake/delivery.js";
import type { AskQuotaConfig } from "./askQuota.js";

export class AgentWorkScheduler extends Context.Service<
  AgentWorkScheduler,
  {
    readonly submit: (command: IntakeCommand, log: RequestLogger) => Effect.Effect<void, Error>;
    readonly ping: () => Effect.Effect<boolean>;
  }
>()("AgentWorkScheduler") {}

export function makeAgentWorkScheduler(
  pool: Pool,
  boss: PgBoss,
  cfg: Pick<Config, "features"> & { readonly ask?: Partial<AskQuotaConfig> },
) {
  return AgentWorkScheduler.of({
    submit: (command, log) =>
      Effect.tryPromise({
        try: () => runDelivery(pool, boss, cfg, command, log),
        catch: toError,
      }).pipe(Effect.uninterruptible),
    ping: () =>
      Effect.tryPromise({ try: () => pool.query("SELECT 1"), catch: toError }).pipe(
        Effect.timeout(Duration.millis(HEALTH_DB_PING_TIMEOUT_MS)),
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      ),
  });
}
