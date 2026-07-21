import { AppError } from "../../errors/appError.js";

/** Publish-layer gate: external stale/supersede only — never internal deadline. */
export type PublishAbortKind = "continue" | "stale_head" | "superseded";

export type PublishAbortGate = () => Promise<PublishAbortKind>;

/**
 * Mutable cell so tools can close over a gate before RunAbortScope exists.
 * Pre-wiring calls fail closed; install the real gate after scope creation.
 */
export type PublishAbortGateCell = {
  current: PublishAbortGate;
};

export function createPublishAbortGateCell(): PublishAbortGateCell {
  return {
    current: async () => {
      throw new AppError({
        code: "review.publish_abort_gate_uninitialized",
        message: "Publish abort gate invoked before RunAbortScope was wired",
      });
    },
  };
}
