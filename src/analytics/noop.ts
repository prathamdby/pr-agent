import type { AnalyticsSink } from "./types.js";

export const noopAnalyticsSink: AnalyticsSink = {
  captureEvent: () => undefined,
  captureException: () => undefined,
  shutdown: async () => undefined,
};
