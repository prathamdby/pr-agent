import type { DatabaseSync } from "node:sqlite";
import { Context, Effect } from "effect";
import type { Config } from "../settings/index.ts";
import { recordEvent, type RequestLogger } from "../evlog.ts";
import { toError } from "../errors/errorMessage.ts";
import { runDelivery, type IntakeCommand } from "../state/intake.ts";

export class WebhookIntake extends Context.Service<
  WebhookIntake,
  {
    readonly submit: (command: IntakeCommand, log: RequestLogger) => Effect.Effect<void, Error>;
    readonly ping: () => Effect.Effect<boolean>;
    readonly accepting: () => boolean;
  }
>()("WebhookIntake") {}

export function makeSqliteWebhookIntake(params: {
  readonly db: DatabaseSync;
  readonly cfg: Pick<Config, "features" | "ask">;
  readonly accepting: () => boolean;
  readonly ready: () => boolean;
  readonly afterCommit: (conversationsToAbort: readonly string[]) => void;
  readonly now?: () => number;
}) {
  const now = params.now ?? Date.now;
  return WebhookIntake.of({
    submit: (command, log) =>
      Effect.try({
        try: () => {
          const result = runDelivery(
            params.db,
            { features: params.cfg.features, ask: params.cfg.ask },
            command,
            now(),
          );
          for (const event of result.events) {
            recordEvent(log, event.name, event.fields, event.level ?? "info");
          }
          params.afterCommit(result.conversationsToAbort);
        },
        catch: toError,
      }).pipe(Effect.uninterruptible),
    ping: () => Effect.sync(() => params.ready()),
    accepting: params.accepting,
  });
}
