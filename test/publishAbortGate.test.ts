import { describe, expect, it } from "vitest";
import { isAppError } from "../src/errors/appError.js";
import { createPublishAbortGateCell } from "../src/review/publish/publishAbortGate.js";

describe("createPublishAbortGateCell", () => {
  it("fails closed with AppError before the real gate is installed", async () => {
    const cell = createPublishAbortGateCell();
    await expect(cell.current()).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) && error.code === "review.publish_abort_gate_uninitialized",
    );
  });

  it("delegates to the installed publishGate", async () => {
    const cell = createPublishAbortGateCell();
    cell.current = async () => "stale_head";
    await expect(cell.current()).resolves.toBe("stale_head");
  });
});
