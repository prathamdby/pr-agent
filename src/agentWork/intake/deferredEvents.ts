import { recordEvent, type RequestLogger, type WideEventLevel } from "../../evlog.js";

export type DeferredIntakeEvent = {
  readonly name: string;
  readonly fields?: Record<string, unknown>;
  readonly level?: WideEventLevel;
};

export function flushDeferredEvents(
  intakeLog: RequestLogger,
  events: readonly DeferredIntakeEvent[],
): void {
  for (const event of events) {
    recordEvent(intakeLog, event.name, event.fields, event.level ?? "info");
  }
}
