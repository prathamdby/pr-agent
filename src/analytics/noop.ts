import type { AnalyticsSink } from "./types.ts";

export const noopAnalyticsSink: AnalyticsSink = {
  captureEvent() {},
  captureException() {},
  async shutdown() {},
};
