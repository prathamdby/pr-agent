import { describe, expect, it } from "vitest";
import {
  CURSOR_RUN_ERROR_PREFIX,
  CURSOR_STARTUP_ERROR_PREFIX,
  formatCursorRunError,
  formatCursorStartupError,
  isCursorRunError,
  isCursorStartupError,
} from "../src/agent/providers/cursor/errors.js";

describe("cursor error formatting", () => {
  it("formats startup and run errors with distinct prefixes", () => {
    const startup = formatCursorStartupError(
      Object.assign(new Error("auth failed"), {
        name: "CursorAgentError",
        isRetryable: true,
      }),
    );
    expect(startup).toContain(CURSOR_STARTUP_ERROR_PREFIX);
    expect(isCursorStartupError(startup)).toBe(true);

    const run = formatCursorRunError("run-123");
    expect(run).toBe(`${CURSOR_RUN_ERROR_PREFIX} run-123`);
    expect(isCursorRunError(run)).toBe(true);
  });
});
