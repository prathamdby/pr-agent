import type { AnalyticsSink } from "./types.js";

export const noopAnalyticsSink: AnalyticsSink = {
  captureEvent() {},
  captureException() {},
  async shutdown() {},
};
