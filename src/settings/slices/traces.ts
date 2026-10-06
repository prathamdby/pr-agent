import { AppError } from "../../errors/appError.js";
import { ENV } from "../envKeys.js";
import { readEnum, readPositiveInteger } from "../envReaders.js";

export type TracesSlice = {
  readonly mode: "off" | "metadata" | "content";
  readonly retentionSeconds: number;
  readonly bufferMaxSpans: number;
};

export function readTracesSlice(agentWorkSeconds: number): TracesSlice {
  const retentionSeconds = readPositiveInteger(ENV.TRACES_RETENTION_SECONDS, 1_209_600);
  if (retentionSeconds > agentWorkSeconds) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message: "TRACES_RETENTION_SECONDS must not exceed AGENT_WORK_RETENTION_SECONDS",
    });
  }
  return {
    mode: readEnum(ENV.TRACES_MODE, ["off", "metadata", "content"] as const, "metadata"),
    retentionSeconds,
    bufferMaxSpans: readPositiveInteger(ENV.TRACES_BUFFER_MAX_SPANS, 400),
  };
}
